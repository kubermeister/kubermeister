# The screenshot harness

Generates the screenshots the documentation in `docs/` and the website show. It is not a test suite:
nothing here asserts that the app is correct, and `npm run test:e2e` never touches it.

```sh
npm run build                          # the harness drives out/, like the end-to-end suite
npm run screenshots                    # boots the demo cluster, shoots every shot in both themes
npm run screenshots:sync -- <shot>...  # commits the named shots as WebP
```

Raw shots land in `.screenshots/dark/` and `.screenshots/light/`, one PNG per shot name, and are
ignored by git. What is committed is `docs/screenshots/<theme>/<shot>.webp`, which the sync writes
from them: near-lossless WebP at most 2048 px wide, a third the size of the PNG.

The sync writes **only the shots it is given**, plus any shot that has no image yet; `--all`
replaces the whole set. Every run differs from the last in ages, timestamps, chart lines and
generated pod names, so a pull request commits the shots of the screens it changed and leaves the
rest alone, rather than adding a whole set of new bytes to history each time.

## Why generate them

A hand-taken screenshot goes stale in one release and nobody notices until a user does. These
regenerate on demand, contain no real cluster's data to redact, and fail loudly on the shot whose
screen changed, which is how UI drift gets noticed.

## What the demo cluster is not

It is a second disposable k3s container with its own name, kubeconfig and state file, so a
screenshot run and an end-to-end run can never reach into each other's cluster. The developer's
`~/.kube/config` and `$KUBECONFIG` are never read.

It differs from `tests/e2e` in what it leaves switched on. That harness disables metrics-server,
traefik and servicelb because the specs do not need them; here they are the picture. Without
metrics-server the dashboard charts, the usage meters on every list and the per-container figures
are all zeroes.

## The seed

`fixtures/seed.yaml` is written to be photographed rather than asserted on: three namespaces, names
that read like an application somebody runs, and three workloads broken on purpose — an image that
does not exist, a container that exits non-zero, and a pod whose node selector nothing matches. A
screenshot of an all-green cluster is a screenshot of nothing, and the alerts panel needs something
to carry.

`fixtures/chart/` is a small Helm chart the harness really installs and then really upgrades, so the
release screens read bookkeeping Helm itself wrote rather than pre-encoded Secrets.

## Environment

| Variable        | Default | Effect                                                                 |
| --------------- | ------- | ---------------------------------------------------------------------- |
| `KM_DEMO_FRESH` | unset   | `1` removes the container and reseeds from scratch                     |
| `KM_DEMO_SCALE` | unset   | `2` forces a 2x device scale factor (a retina Mac already captures 2x) |

The cluster is **kept between runs** by default, which the end-to-end one is not. Two reasons: a
run is slow to boot, and every object's Age column reads `30s` on a cluster that started a minute
ago. Letting one soak overnight is what makes the ages look like a cluster that has been up a while.
Remove it with `docker rm -f km-demo-cluster`.

## Timing traps

- **The sampler is in memory and starts empty.** Its buffers do not survive a relaunch and it reads
  every 12 s, so a chart of the app as it ships is a flat line for minutes and a different one every
  run. The app is left as it ships: `harness/history.ts` replaces the handlers of the three channels
  the charts read (`metrics.sparklines`, `metrics.workloadHealth`, `metrics.nodeSeries`) from
  outside, through Playwright's `app.evaluate` and Electron's public `ipcMain`, with a hundred
  points that end at the cluster's real usage from `kubectl top node` and have the same shape every
  run. Every other channel, the figures beside the charts included, answers from the cluster.
- **Ages and events want different vintages.** A kept cluster ages its objects usefully but its
  seeded events fall out of the recent window after about an hour, so a set shot on a days-old
  cluster has convincing ages and an empty events panel. Reseed with `KM_DEMO_FRESH=1` when the
  events panel is in the shot.
- **One launch shoots both themes**, the whole list in dark and then in light, with a reload
  between them, so whatever a shot leaves behind is still there for every shot after it.
- **`deployment-compare` can write to the cluster.** On a cluster with one rollout it restarts the
  deployment to create a second revision, which rolls the pods every other shot was taken against,
  so it runs after both passes, and only the first of its two runs ever writes.
- **`port-forwards` leaves a forward remembered** for as long as the app runs, which puts its button
  in the top bar of every later screen, so it runs after both passes too.

## Adding a shot

Add a `test('<name>')` to `shots/screenshots.test.ts`. Each shot is its own test so a shot that
cannot be composed names itself in the report instead of taking the set down with it. Navigate by
hash (`goto('/workloads/pods')`) rather than clicking through the sidebar: the router uses hash
history, so a route is one step away and a broken shot fails on its own screen.

## Framing

`window.screenshot()` captures the renderer, with no window chrome. Frame it in the site's CSS
rather than at capture time: chrome and a shadow baked into the PNG is a look you cannot change
later, and it stays sharp when the page scales it.
