#!/usr/bin/env python3
"""Repair a sysbox agent whose upper layer got ID-shifted one time too many.

SYMPTOM
    Inside the container a pile of files that should belong to root — most
    damagingly /etc/passwd, /etc/shadow, /etc/group, /etc/gshadow — are owned by
    uid 65534. Unlike the under-shift fault (see fix-sysbox-idmap.py) the setuid
    binaries are usually FINE, so `sudo` works and nothing looks wrong until PAM
    is asked to authenticate:

        unix_chkpwd[...]: could not obtain user info (agent)
        (systemd)[...]: PAM failed: Authentication failure
        user@1000.service: Failed to set up PAM session: Operation not permitted

    user@1000.service then dies 224/PAM, so /run/user/1000 and the session D-Bus
    never appear, so `gnome-session` exits "too early (< 3 seconds)", so
    tigervncserver@:1 tears the X session down — and the agent's dashboard
    preview goes blank, because /api/screenshot captures DISPLAY :1.

    With the desktop-toggle drop-in's Restart=always in place that becomes an
    endless respawn (restart counter in the thousands); without it the desktop
    just silently stays down. Both are this same fault underneath.

CAUSE
    sysbox chowns the overlay upper layer 0 -> BASE on start and BASE -> 0 on
    stop, where BASE is the container's subuid (165536 here, from /etc/subuid).
    These files got the start-shift applied TWICE and sit at 2*BASE, which is
    outside the container's userns map [BASE, BASE+RANGE) — so the kernel
    reports the overflow uid, 65534.

    That the value is exactly `correct + BASE` is what makes this repairable
    without guessing: every observed uid/gid is a real container id plus one
    surplus BASE (331072 = root, 332072 = the agent user, 331114 = gid shadow).

    Note this is the MIRROR of the fault fix-sysbox-idmap.py handles, where
    files missed a shift and stayed at 0. Both surface inside as 65534, so the
    in-container view alone cannot tell them apart — check the host-side owner:

        nsenter -t <pid> -m -- stat -c %u /etc/shadow    # BASE ok, 2*BASE here, 0 = the other fault

FIX
    Subtract one BASE from every entry in [2*BASE, 2*BASE+RANGE). Entries
    already in [BASE, BASE+RANGE) are correct for a running container and are
    left alone, which makes this idempotent.

    Only the upper layer is walked, so the shared read-only image layers are
    never touched and no copy-up is triggered.

USAGE
    Runs against a RUNNING container — the opposite of fix-sysbox-idmap.py, and
    for the same reason: `correct` is BASE while running and 0 while stopped, so
    only a live container makes 2*BASE unambiguously wrong. Dry run first.

        sudo python3 scripts/fix-sysbox-overshift.py swarm-agent-<id>
        sudo python3 scripts/fix-sysbox-overshift.py swarm-agent-<id> --apply

    Nothing needs to restart for the ownership itself to take effect, but the
    units that already gave up do:

        docker exec -u 0 swarm-agent-<id> systemctl reset-failed user@1000.service
        docker exec -u 0 swarm-agent-<id> systemctl restart tigervncserver@:1.service

    Then `systemctl is-active user@1000.service` should report active and the
    dashboard preview should come back within a few seconds.
"""

import json
import os
import subprocess
import sys

# Matches /etc/subuid's `sysbox:165536:65536`. Read that file if it ever changes.
BASE = 165536
RANGE = 65536
# A running container's ids live in [BASE, BASE+RANGE). One surplus shift lands
# them here, which is what this script pulls back down.
OVER_LO = 2 * BASE
OVER_HI = 2 * BASE + RANGE


def inspect(container: str) -> dict:
    out = subprocess.run(["docker", "inspect", container], capture_output=True, text=True)
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
    if not info["State"]["Running"]:
        # While stopped the correct base is 0 and BASE means "stuck un-shifted",
        # which is fix-sysbox-idmap.py's job. Refuse rather than guess.
        print(
            f"{container} is STOPPED — start it first. While stopped an over-shift is "
            "indistinguishable from the under-shift fault (see fix-sysbox-idmap.py).",
            file=sys.stderr,
        )
        return 1

    root = info["GraphDriver"]["Data"]["UpperDir"]
    if not os.path.isdir(root):
        print(f"upper layer not found: {root}", file=sys.stderr)
        return 1

    if apply_changes:
        backup = f"/var/tmp/{container}-overshift-owners.bak"
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
    unexpected = []
    for dirpath, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        for path in [dirpath] + [os.path.join(dirpath, n) for n in dirnames + filenames]:
            try:
                st = os.lstat(path)
            except OSError:
                continue
            uid, gid = st.st_uid, st.st_gid
            new_uid = uid - BASE if OVER_LO <= uid < OVER_HI else uid
            new_gid = gid - BASE if OVER_LO <= gid < OVER_HI else gid
            # Anything else out of the running frame is not this fault; report it
            # rather than shifting it, since the right target would be a guess.
            if not (BASE <= uid < BASE + RANGE or OVER_LO <= uid < OVER_HI) or not (
                BASE <= gid < BASE + RANGE or OVER_LO <= gid < OVER_HI
            ):
                unexpected.append((uid, gid, path))
            if (new_uid, new_gid) == (uid, gid):
                skipped += 1
                continue
            changed += 1
            if apply_changes:
                os.lchown(path, new_uid, new_gid)

    verb = "chowned" if apply_changes else "would chown"
    print(f"{verb}: {changed}   already correct: {skipped}")
    if unexpected:
        print(f"NOTE: {len(unexpected)} entries outside both frames, left untouched:")
        for uid, gid, path in unexpected[:10]:
            print(f"  {uid}:{gid} {path}")
    if not apply_changes:
        print("dry run — re-run with --apply to commit")
    return 0


if __name__ == "__main__":
    sys.exit(main())
