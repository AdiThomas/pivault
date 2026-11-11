# Looking after PiVault

Day-to-day commands, and what to do when something goes wrong. Everything here runs
on the Pi over SSH:

```bash
ssh -i ~/.ssh/pivault_ed25519 pi@pivault.local
```

## Everyday commands

| Command | What it does |
| --- | --- |
| `sudo pivault-info` | Addresses, login details, storage and service status |
| `sudo pivault-apply` | Re-apply the whole configuration (safe any time) |
| `sudo pivault-apply app` | Rebuild and restart only the containers |
| `sudo pivault-backup` | Run a backup now |
| `sudo pivault-restore-test` | Restore a random folder and compare it with the live files |
| `sudo pivault-snapraid-sync` | Update parity now |
| `systemctl list-timers 'pivault-*'` | When each scheduled job runs next |
| `journalctl -u pivault-backup -n 50` | Output of the last backup |

Container commands are run from the deploy folder:

```bash
cd /opt/pivault/deploy
sudo docker compose ps
sudo docker compose logs -f api worker
sudo docker compose restart api
```

Account commands:

```bash
sudo docker compose exec api python -m app.cli create-user someone@example.com
sudo docker compose exec api python -m app.cli set-password you@example.com
sudo docker compose exec api python -m app.cli reprocess --failed   # rebuild thumbnails
sudo docker compose exec api python -m app.cli verify               # check every file's hash
```

## Updating PiVault

Copy the new code to `/opt/pivault` (for example with the Ansible playbook from your
PC, `-e pivault_sync_repo=true`), then:

```bash
sudo pivault-apply app
```

Database changes are applied automatically when the API starts. Or tag a release in
GitHub and let the Release workflow build the images and update the Pi.

## Adding a drive

`pivault-setup-disks` erases every drive it lists, so do not use it to add a drive to
a pool that already holds photos. Instead:

```bash
lsblk -o NAME,SIZE,MODEL,LABEL                 # find the new drive, e.g. /dev/sdd
sudo parted -s /dev/sdd mklabel gpt mkpart primary ext4 1MiB 100%
sudo mkfs.ext4 -m 0 -L pivault-data3 /dev/sdd1 # next free number

cd /opt/pivault/deploy && sudo docker compose down
sudo systemctl stop mnt-storage.mount
sudo pivault-apply storage
sudo pivault-apply app
```

The new drive must not be larger than the parity drive. Check the device name twice:
`mkfs` erases whatever you point it at.

## A drive has failed

Do not run a SnapRAID sync. A sync would record the loss as intended.

1. Stop PiVault and the nightly sync:

   ```bash
   cd /opt/pivault/deploy && sudo docker compose down
   sudo systemctl stop pivault-snapraid-sync.timer
   ```

2. Replace the drive and format the new one with the **same label** as the dead one
   (for example `pivault-data2`), as in "Adding a drive".
3. Mount it and rebuild its contents from parity:

   ```bash
   sudo pivault-apply storage
   sudo snapraid fix -d d2          # d2 for pivault-data2, d1 for pivault-data1
   sudo snapraid check -d d2 -a
   # SnapRAID restores files as root. Give them back to PiVault, or it cannot read them.
   sudo chown -R 1000:1000 /mnt/storage/pivault/originals /mnt/storage/pivault/files /mnt/storage/pivault/thumbs
   ```

4. Start everything again:

   ```bash
   sudo systemctl start pivault-snapraid-sync.timer
   sudo pivault-apply app
   ```

Files added after the last nightly sync were not yet in parity. Recover those from the
restic backup, or re-run backup from the phone: anything missing is uploaded again.

If drive 1 failed, the database went with it. Restore it from the newest dump:

```bash
ls /mnt/storage/pivault/db-dumps/
cd /opt/pivault/deploy
sudo docker compose up -d postgres
sudo docker compose exec -T postgres pg_restore -U pivault -d pivault --clean --if-exists \
  < /mnt/storage/pivault/db-dumps/pivault-YYYY-MM-DD.dump
sudo docker compose up -d
```

## Restoring from backup

After a total loss (theft, fire, both drives gone), on a freshly set-up Pi:

```bash
sudo cp /etc/pivault/restic.env.example /etc/pivault/restic.env   # fill in as before
echo 'YOUR-SAVED-PASSWORD' | sudo tee /etc/pivault/restic-password
set -a; . /etc/pivault/restic.env; set +a

cd /opt/pivault/deploy && sudo docker compose down
sudo -E restic -r "$RESTIC_REPO_B2" snapshots
sudo -E restic -r "$RESTIC_REPO_B2" restore latest --target /
sudo chown -R 1000:1000 /mnt/storage/pivault
```

Then restore the database from the newest dump as shown above, start PiVault, and
rebuild the thumbnails (they are not backed up):

```bash
sudo docker compose up -d
sudo docker compose exec api python -m app.cli reprocess
```

To get back one deleted file instead, restore it somewhere else and upload it again:

```bash
sudo -E restic -r "$RESTIC_REPO_LOCAL" find 'IMG_1234*'
sudo -E restic -r "$RESTIC_REPO_LOCAL" restore latest --include /mnt/storage/pivault/originals/2026/10 --target /tmp/restore
```

## The SD card has died

The SD card holds only the operating system and Docker. Photos, the database and its
dumps are on the SSDs.

1. Build and write a new image ([SETUP.md](SETUP.md), steps 1 to 3). Use the same
   `PIVAULT_ADMIN_EMAIL`.
2. Leave the SSDs plugged in. On first boot the drives are found by their labels and
   mounted, and PiVault starts on the existing data.
3. Nothing else to restore: a copy of the settings (database password, login secret)
   and the backup password is kept on drive 1 in `/mnt/disk1/.pivault/`, and a new
   SD card picks them up automatically.
4. Rejoin Tailscale (`sudo tailscale up`, then `sudo pivault-apply app`) and copy your
   `/etc/pivault/restic.env` settings back in.

## Troubleshooting

**The app says it cannot reach the server.** Check Tailscale is connected on the
phone. On the Pi, `sudo pivault-info` shows whether the API is healthy and whether
Tailscale is running.

**The address works in a browser on the Pi's network but HTTPS fails.** HTTPS
certificates must be enabled in the Tailscale admin console (DNS page). Then
`sudo pivault-apply app`, and look at `sudo docker compose logs caddy`.

**Uploads fail and the disk looks empty.** A drive has probably dropped out. PiVault
locks the empty mount points so nothing lands on the SD card by mistake. Check
`lsblk` and `systemctl status mnt-storage.mount`, reseat the cables, then
`sudo systemctl start mnt-storage.mount && sudo pivault-apply app`.

**Photos show a spinner or a warning icon.** The worker is still making thumbnails, or
could not read the file. `sudo docker compose logs worker`, then
`python -m app.cli reprocess --failed`. The original is always kept.

**The nightly SnapRAID sync refused to run.** More than 500 files disappeared since
the last sync. If you meant to delete them, run `sudo snapraid sync`. If not, your
files are still recoverable: `sudo snapraid fix -m` restores what is missing. Then
give the restored files back to PiVault with
`sudo chown -R 1000:1000 /mnt/storage/pivault/originals /mnt/storage/pivault/files`.

**A photo opens as an error after a recovery.** The file is probably owned by root.
Run the `chown` command above.

**The Pi is hot or slow.** The Grafana dashboard shows temperature and CPU. The first
backup of a large library keeps the worker busy for a while.

**First boot never finished.** `sudo tail -100 /var/log/pivault-firstboot.log`. It
retries every two minutes; `sudo systemctl start pivault-firstboot` runs it now.

## Checking drive health

```bash
sudo smartctl -a /dev/sda        # per drive; look at wear and reallocated sectors
```

Old SSDs can have a lot of wear. Check each one before trusting it, and again every
few months.
