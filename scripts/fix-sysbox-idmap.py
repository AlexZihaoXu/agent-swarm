#!/usr/bin/env python3
"""Repair a sysbox agent whose setuid binaries stopped being able to elevate.

SYMPTOM
    Inside the container /usr/bin/sudo (and every other root-owned file) is
    owned by uid 65534 instead of 0, so the setuid bit cannot elevate and
    anything privileged — apt, systemctl — fails. Nothing breaks until
    something actually needs root, so this can sit unnoticed for days. The
    dashboard flags it as "no sudo"; /api/stats reports privileges.ok = false.

CAUSE
    sysbox chowns a container's overlay upper layer 0 -> BASE when it starts and
    BASE -> 0 when it stops, where BASE is the container's subuid (165536 here,
    from /etc/subuid). An affected container gets stuck SHIFTED: its upper layer
    reads BASE even while stopped, and sysbox logs no chown for it. On every
    subsequent start sysbox sees a rootfs that already looks shifted, concludes
    there is nothing to do, and never establishes the ID-mapping for the rootfs.
    The image's lower layers are shared and stay owned by host root, which is an
    unmapped uid inside the container's userns — hence 65534.

    This is why the migration version is irrelevant (migrations ship files, not
    mount configuration), and why restarting never helps: each start simply
    re-confirms "already shifted".

    Verify with, for a stopped container, `stat -c %u <UpperDir>`: 0 is healthy,
    BASE means stuck. For a running one, compare the in-container view against
    the mount alone:
        docker exec <c> stat -c %u /usr/bin/sudo          # 0 healthy, 65534 broken
        nsenter -t <pid> -m -- stat -c %u /usr/bin/sudo   # BASE healthy, 0 broken

FIX
    Put the upper layer back where a stopped container should be, then let
    sysbox do its normal setup on the next start.

    This SHIFTS, it does not flatten. Chowning everything to 0 would collapse
    container-root (BASE) and the agent user (BASE+1000) into one owner, and
    sysbox's start-chown would then hand every one of the agent's files to root.
    Entries already outside [BASE, BASE+RANGE) are left alone — those are files
    `docker cp` wrote as host root during migrations, already in the un-shifted
    frame. Idempotent: a second pass sees the shifted value below BASE and skips.

USAGE
    Takes the CONTAINER, not a path, so it can refuse to run against a live one.
    Dry run first; --apply to commit.

        docker stop swarm-agent-<id>
        sudo python3 scripts/fix-sysbox-idmap.py swarm-agent-<id>            # dry run
        sudo python3 scripts/fix-sysbox-idmap.py swarm-agent-<id> --apply
        docker start swarm-agent-<id>

    Then confirm sysbox took over again — stopping it should now log
    "chown rootfs overlayfs upper layer (BASE -> 0)" in `journalctl -u sysbox-mgr`,
    and `sudo -n true` should succeed inside the container.

    Refusing to run while the container is UP is not a formality. A running
    container's upper layer is legitimately at BASE, because sysbox put it
    there — shifting it then would corrupt a perfectly healthy agent, and the
    healthy and stuck states look identical from the layer alone. Only the
    container being stopped distinguishes them.

    An ownership backup is written next to the script's output automatically;
    keep it if you want a way back.
"""

import json
import os
import subprocess
import sys

# Matches /etc/subuid's `sysbox:165536:65536`. Read that file if it ever changes.
BASE = 165536
RANGE = 65536


def inspect(container: str) -> dict:
    out = subprocess.run(
        ["docker", "inspect", container],
        capture_output=True,
        text=True,
    )
    if out.returncode != 0:
        print(f"docker inspect failed: {out.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    return json.loads(out.stdout)[0]


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    container = sys.argv[1]
    apply_changes = "--apply" in sys.argv[2:]

    info = inspect(container)
    if info["HostConfig"].get("Runtime") != "sysbox-runc":
        print(f"{container} is not a sysbox container — this fault cannot apply.", file=sys.stderr)
        return 1
    if info["State"]["Running"]:
        # A running container's upper layer is SUPPOSED to sit at BASE. Shifting
        # it here would break a healthy agent, and from the layer alone a healthy
        # running container is indistinguishable from a stuck stopped one.
        print(f"{container} is RUNNING — stop it first. Refusing to touch a live rootfs.", file=sys.stderr)
        return 1

    root = info["GraphDriver"]["Data"]["UpperDir"]
    if not os.path.isdir(root):
        print(f"upper layer not found: {root}", file=sys.stderr)
        return 1

    owner = os.stat(root).st_uid
    if owner == 0:
        print(f"{container}: upper layer already at 0 — not stuck, nothing to do.")
        return 0
    if owner != BASE:
        print(f"{container}: upper layer owned by {owner}, expected {BASE} — not the known fault.", file=sys.stderr)
        return 1
    print(f"{container}: stopped, upper layer stuck at {BASE} — this is the fault.")

    if apply_changes:
        backup = f"/var/tmp/{container}-upper-owners.bak"
        with open(backup, "w") as fh:
            for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
                for p in [dirpath] + [os.path.join(dirpath, n) for n in dirnames + filenames]:
                    try:
                        st = os.lstat(p)
                    except OSError:
                        continue
                    fh.write(f"{st.st_uid} {st.st_gid} {p}\n")
        print(f"ownership backup: {backup}")

    changed = skipped = 0
    outside = []
    for dirpath, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        paths = [dirpath] + [os.path.join(dirpath, n) for n in dirnames + filenames]
        for path in paths:
            try:
                st = os.lstat(path)
            except OSError:
                continue
            uid, gid = st.st_uid, st.st_gid
            new_uid = uid - BASE if BASE <= uid < BASE + RANGE else uid
            new_gid = gid - BASE if BASE <= gid < BASE + RANGE else gid
            if uid >= BASE + RANGE or gid >= BASE + RANGE:
                outside.append((uid, gid, path))
            if (new_uid, new_gid) == (uid, gid):
                skipped += 1
                continue
            changed += 1
            if apply_changes:
                os.lchown(path, new_uid, new_gid)

    verb = "chowned" if apply_changes else "would chown"
    print(f"{verb}: {changed}   unchanged: {skipped}")
    if outside:
        # Above the subuid range means something wrote with an unexpected
        # mapping; shifting those would be a guess, so they are reported instead.
        print(f"WARNING: {len(outside)} entries above the subuid range, left untouched:")
        for uid, gid, path in outside[:10]:
            print(f"  {uid}:{gid} {path}")
    if not apply_changes:
        print("dry run — re-run with --apply to commit")
    return 0


if __name__ == "__main__":
    sys.exit(main())
