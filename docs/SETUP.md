# Setting up the Raspberry Pi

This takes you from a blank SD card to a working PiVault server. Plan on about an
hour, most of it waiting.

You need:

- Raspberry Pi 5 (8 GB) with its 27 W power supply
- A microSD card (32 GB or larger) and a card reader
- An Ethernet cable to your router (recommended), or Wi-Fi
- A PC with Docker Desktop, for building the image
- A free [Tailscale](https://tailscale.com) account

The SSDs are optional on day one. Without them PiVault stores on the SD card, and you
move to the drives later with one command.

## 1. Build the SD-card image

Raspberry Pi boards boot from a `.img` file, not an `.iso`.

1. Copy `infra/image/config.env.example` to `infra/image/config.env` and edit it:
   - `PIVAULT_ADMIN_EMAIL`: the email you will log in to the app with
   - `WIFI_SSID` and `WIFI_PASSWORD`: only if you want Wi-Fi. Leave empty for Ethernet.
   - `TAILSCALE_AUTHKEY`: optional, see step 4
2. Start Docker Desktop.
3. Build:

   ```powershell
   .\infra\image\build.ps1          # PowerShell
   ```
   ```bash
   infra/image/build.sh             # Git Bash, WSL, Linux, macOS
   ```

The build downloads the official Raspberry Pi OS Lite (64-bit), checks its hash, adds
PiVault and a first-boot setup service, and writes:

- `infra/image/build/pivault-rpi5-arm64.img.xz`: the image
- `infra/image/build/credentials.txt`: your app password and the Pi's console password

It also creates an SSH key for the Pi at `~/.ssh/pivault_ed25519`. Nothing is flashed.

## 2. Write the image to the SD card

1. Install and open [Raspberry Pi Imager](https://www.raspberrypi.com/software/).
2. Device: **Raspberry Pi 5**. Operating system: **Use custom**, then pick the
   `.img.xz` file. Storage: your SD card.
3. If Imager offers to apply OS customisation settings, choose **No**. The image is
   already configured, and Imager's settings would overwrite that.
4. Write, then eject the card.

## 3. First boot

1. Put the card in the Pi, plug in Ethernet, then power.
2. Wait. The Pi resizes its disk, reboots, then installs Docker and Tailscale and
   builds PiVault. This takes 20 to 30 minutes and needs internet.
3. Watch it if you like:

   ```bash
   ssh -i ~/.ssh/pivault_ed25519 pi@pivault.local
   sudo tail -f /var/log/pivault-firstboot.log
   ```

   If `pivault.local` does not resolve, use the Pi's IP address from your router's
   device list.

When the log ends with "PiVault first boot finished", run:

```bash
sudo pivault-info
```

It shows the addresses, the login and the state of each service.

If setup stopped part-way (for example the internet dropped), it retries by itself
every two minutes. To run it immediately: `sudo systemctl start pivault-firstboot`.

## 4. Connect Tailscale

Tailscale is how your phone reaches the Pi from anywhere, without opening router ports.

1. In the [Tailscale admin console](https://login.tailscale.com/admin/dns), on the DNS
   page, turn on **MagicDNS** and **HTTPS Certificates**.
2. On the Pi:

   ```bash
   sudo tailscale up
   ```

   Open the link it prints and approve the device. (Skip this if you put an auth key
   in `config.env`.)
3. Tell PiVault its new address:

   ```bash
   sudo pivault-apply app
   sudo pivault-info
   ```

`pivault-info` now shows an address like `https://pivault.tail1234.ts.net`. The first
visit takes a few seconds while the certificate is issued.

In the admin console, also turn off key expiry for the Pi (Machines, the Pi's menu,
**Disable key expiry**), or it will drop off your tailnet after 180 days.

Install Tailscale on your iPhone and sign in with the same account.

## 5. Log in

Open the address in a browser, or in the app (see [APP.md](APP.md)):

- Server: `pivault.tail1234.ts.net` (yours will differ)
- Email and password: from `credentials.txt`, or `sudo pivault-info`

Change the password in Settings once you are in.

## 6. Set up the SSDs

Do this when the drives and the powered USB hub have arrived. Use a **powered** hub:
the Pi cannot power three SSDs by itself, and a drive that loses power mid-write can
corrupt data.

1. Plug each SSD (in its enclosure) into the powered hub, and the hub into a blue
   USB 3 port on the Pi.
2. Run:

   ```bash
   sudo pivault-setup-disks
   ```

It lists the drives it found, proposes a layout, and makes you type `ERASE` before it
touches anything. Then it formats and labels the drives, moves whatever PiVault had
stored on the SD card onto them, and restarts PiVault.

| Drives | Layout | Usable | If one drive dies |
| --- | --- | --- | --- |
| 1 | one data drive | all of it | data on it is lost (restore from backup) |
| 2 | two data drives, pooled | both | only the files on that drive are lost |
| 3 × 250 GB | two data + one parity | 500 GB | rebuilt from parity |

Parity is updated nightly at 03:00, so files added since the last sync are not yet
protected by it. To build parity straight away: `sudo pivault-snapraid-sync`.

**Adding or replacing drives later**: plug in the new drive and run
`sudo pivault-setup-disks` again. It erases every drive it lists, so for adding a
drive to a pool that already holds photos, follow "Adding a drive" in
[OPERATIONS.md](OPERATIONS.md) instead.

## 7. Backups

SnapRAID protects against a dead drive. It does not protect against deleting the wrong
thing, fire or theft. For that, set up at least one restic destination.

```bash
sudo cp /etc/pivault/restic.env.example /etc/pivault/restic.env
sudo nano /etc/pivault/restic.env
```

Fill in an external USB drive, Backblaze B2, or both (the file explains each line).
Then run the first backup and a restore test:

```bash
sudo pivault-backup
sudo pivault-restore-test
```

**Save the backup password.** `/etc/pivault/restic-password` encrypts your backups.
Copy it into a password manager now. Without it the backups cannot be read, and if
the SD card dies it dies with it.

```bash
sudo cat /etc/pivault/restic-password
```

Keep iCloud Photos turned on until `pivault-restore-test` has passed and you have
lived with PiVault for a month.

## What runs when

| When | Job | Command to run it now |
| --- | --- | --- |
| 02:30 nightly | Database dump into the pool | `sudo pivault-pg-dump` |
| 03:00 nightly | SnapRAID sync (updates parity) | `sudo pivault-snapraid-sync` |
| 03:30 nightly | restic backup, keeps 7 daily, 4 weekly, 12 monthly | `sudo pivault-backup` |
| Sunday 04:30 | SnapRAID scrub (finds silent corruption) | `sudo pivault-snapraid-sync scrub` |
| 1st of the month | Restore a random folder and compare hashes | `sudo pivault-restore-test` |
| 04:15 nightly | Empty trash older than 30 days | (inside the worker) |

`systemctl list-timers 'pivault-*'` shows the next run of each.

## Monitoring

Grafana is at `https://<your-pi>/grafana/`. The username is `admin` and the password
is shown by `sudo pivault-info`. The PiVault dashboard opens by default.

## Security summary

- No router port forwarding. From outside your home, the only way in is Tailscale.
- The firewall allows Tailscale, plus SSH from your home network. Nothing else.
- SSH accepts your key only, not passwords.
- HTTPS uses a real certificate issued through Tailscale.
- Login attempts are rate-limited, uploads are capped at 10 GB each, and secrets live
  in `/opt/pivault/deploy/.env`, readable only by root.
