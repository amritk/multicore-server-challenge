#!/usr/bin/env python3
"""The target's CPU monitor for `loadgen search`: one CSV row every INTERVAL seconds.

    monitor.py INTERVAL OUT.csv

search runs it as `<monitor> 1 <tag>.csv` in its -monitor-dir and averages the columns over the measured window
(search.go, monitorAverages): `time` (unix seconds), `cpu%` and `steal%` of the whole box, and `app_box`,
`pg_box` and `ngx_box`, the share of the whole box used by the submission (user `challenge`), Postgres (user
`postgres`) and Nginx, as the leaderboard reports them.
"""
import os
import sys
import time

INTERVAL = float(sys.argv[1])
OUT = sys.argv[2]


def uid_of(name):
    try:
        with open("/etc/passwd") as f:
            for line in f:
                p = line.split(":")
                if p[0] == name:
                    return int(p[2])
    except OSError:
        pass
    return -1


UIDS = {"app": uid_of("challenge"), "pg": uid_of("postgres")}


def box():
    with open("/proc/stat") as f:
        v = [int(x) for x in f.readline().split()[1:]]
    idle = v[3] + v[4]
    return sum(v[:8]), idle, v[7]


def procs():
    """Ticks used so far by every live process, by pid, with its group."""
    out = {}
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            uid = os.stat("/proc/" + pid).st_uid
            with open("/proc/" + pid + "/stat") as f:
                s = f.read()
        except OSError:
            continue
        name = s[s.index("(") + 1 : s.rindex(")")]
        rest = s[s.rindex(")") + 2 :].split()
        ticks = int(rest[11]) + int(rest[12])
        if name.startswith("nginx"):
            group = "ngx"
        elif uid == UIDS["app"]:
            group = "app"
        elif uid == UIDS["pg"]:
            group = "pg"
        else:
            continue
        out[pid] = (group, ticks)
    return out


with open(OUT, "w", buffering=1) as f:
    f.write("time,cpu%,steal%,app_box,pg_box,ngx_box\n")
    t0, idle0, steal0 = box()
    p0 = procs()
    while True:
        time.sleep(INTERVAL)
        t1, idle1, steal1 = box()
        p1 = procs()
        dt = max(t1 - t0, 1)
        used = {"app": 0, "pg": 0, "ngx": 0}
        for pid, (group, ticks) in p1.items():
            before = p0.get(pid)
            used[group] += ticks - before[1] if before and before[0] == group else 0
        # /proc/stat's total is summed over every CPU, so a process's ticks over it are its share of the box.
        share = lambda ticks: 100.0 * ticks / dt
        f.write(
            "%d,%.1f,%.1f,%.1f,%.1f,%.1f\n"
            % (
                time.time(),
                100.0 * (dt - (idle1 - idle0)) / dt,
                100.0 * (steal1 - steal0) / dt,
                share(used["app"]),
                share(used["pg"]),
                share(used["ngx"]),
            )
        )
        t0, idle0, steal0, p0 = t1, idle1, steal1, p1
