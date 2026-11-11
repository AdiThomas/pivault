# A disposable Debian 13 machine with systemd, for testing the playbook without a Pi.
# See infra/ansible/test/run.sh.
FROM debian:trixie
ENV DEBIAN_FRONTEND=noninteractive container=docker
RUN apt-get update \
    && apt-get install -y --no-install-recommends systemd systemd-sysv dbus sudo ansible rsync \
       python3 curl ca-certificates iproute2 kmod udev procps openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1000 -s /bin/bash pi
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
