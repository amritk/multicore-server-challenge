# Benchmarking on a box like the challenge's

Two machines in one Synteq Cloud location, Ubuntu 24.04, on the same private network:

| | Product | CPU | RAM | Disk |
|---|---|---|---|---|
| target | VPS, **Dedicated** tab | 8 | 16 GB | 100 GB NVMe |
| load box | VPS, Standard tab | 24 | 16 GB | 50 GB NVMe |

The target is the challenge's box: 8 dedicated vCPU, 16 GB, Postgres on the same box, prepared only by
`box/setup-box.sh`, the server run by `box/challenge.service`. The load box runs the challenge's own
`loadgen search`, which is what scores the leaderboard.

## Once

On the target, as root:

```sh
git clone -b claude/nish-vm-bench https://github.com/amritk/multicore-server-challenge /opt/mcsc
bash /opt/mcsc/vm/target.sh setup        # ~15 minutes, most of it the full seed
```

On the load box, as root (TARGET_IP is the target's private address):

```sh
git clone -b claude/nish-vm-bench https://github.com/amritk/multicore-server-challenge /root/mcsc
bash /root/mcsc/vm/loadbox.sh setup TARGET_IP
```

`setup` prints an ssh key when the target refuses root ssh from the load box: add it to the target's
`/root/.ssh/authorized_keys` and run `setup` again. `loadgen search` needs root ssh to the target, as the
official one does.

## Each comparison

```sh
bash /root/mcsc/vm/loadbox.sh plan        # five searches, about an hour each
bash /root/mcsc/vm/loadbox.sh summary
```

or one at a time:

```sh
bash /root/mcsc/vm/loadbox.sh run my-label <commit or branch> [VAR=VALUE ...]
```

Each run rebuilds the submission at that commit (once per commit), resets the database from the seed,
restarts Postgres, starts the server with the extra environment, and runs the full search: warm-up, doubling
probes, bisection to 5%, 5-minute holds. `results/<label>/` keeps the search's log and SUMMARY, every phase's
results and the target's CPU (`monitor.csv`: the whole box, the server, Postgres and Nginx, as the leaderboard
reports them).

Run the calibration (`3de991e`, scored 91,000 officially) first: its result here is the factor between this
target and the official one. A search that ends LG-limited needs a second load box, not a bigger one
(`loadgen search -boxes`).
