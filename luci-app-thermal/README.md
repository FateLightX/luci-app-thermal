# luci-app-thermal

Temperature sensors for the OpenWrt LuCI status page.

Adds a **Temperature** block to *Status → Overview*, alongside Memory and
Storage, using the same `.cbi-progressbar` those blocks use, plus a realtime
graph page at *Status → Realtime Graphs → Temperature*.

**Requires OpenWrt 25.x or later.**

![Status → Overview](preview/screenshot.png)

## What it reads

Everything the kernel exposes through either of the two temperature trees,
with no per-device special-casing:

| Source | Path | Typical sensors |
|---|---|---|
| hwmon | `/sys/class/hwmon/hwmon*/temp*_input` | `coretemp`, `k10temp`, `drivetemp`, `nvme`, ath/mt76 wifi, I²C chips |
| thermal | `/sys/class/thermal/thermal_zone*/temp` | SoC zones, ACPI zones |

Disk temperature needs `kmod-hwmon-drivetemp` (SATA/SAS) — NVMe works out of
the box, since `kmod-nvme` forces `CONFIG_NVME_HWMON=y`. The package depends
on `kmod-hwmon-drivetemp` on x86 targets, so a built x86 image reads SATA
drives without extra setup; on other targets the dependency is absent and the
module can be installed manually.

## The graph page

One graph per chip, so the sensors that share a critical point share an axis.
A CPU's package and per-core readings belong on one plot; a disk at 54 °C and
a CPU core at 42 °C do not, because their limits are 70 and 105 and a shared
axis would misstate both. The y-axis is anchored to the chip's critical point
rather than the observed peak, so a trace that sits low means real headroom.
Threshold bands behind the traces mark where throttling and the critical zone
begin, and a row gains a text label — not just colour — once its own sensor
crosses either.

## What it does differently

Three things that go wrong when you read these trees naively:

**Trip points survive the hwmon/thermal merge.** With `CONFIG_THERMAL_HWMON`
enabled, every thermal zone also gets an hwmon twin. The twin carries the
reading but *not* the zone's trip points, so preferring hwmon silently throws
away the only real limits the kernel offered. On a Celeron J4125, `acpitz`
shows no thresholds via hwmon while `thermal_zone0` declares
`critical 95 / active 65`. This package keeps the reading and folds the
zone's trip points back in.

**Invalid trip points are discarded, not clamped.** `x86_pkg_temp` reports
trip points of `-274000` m°C — the kernel's `THERMAL_TEMP_INVALID` sentinel —
on boards where the BIOS never programmed the threshold registers. Anything
at or below absolute zero is dropped.

**Assumed limits are labelled as assumed.** `drivetemp` exports no `_crit` or
`_max` at all. Rather than showing a disk against a 105 °C CPU limit — where
it would read as fine right up until it isn't — the limit falls back to a
per-class default and the UI says so:

| Class | Assumed hot | Assumed critical |
|---|---|---|
| disk | 60 °C | 70 °C |
| nvme | 70 °C | 80 °C |
| cpu / wifi / other | 95 °C | 105 °C |
| board | 80 °C | 95 °C |

Warning and shutdown tiers are folded from the trip list by *lowest wins*,
because the lowest is the first one the kernel acts on. `max` counts as a
warning, not a shutdown: on NVMe it is WCTEMP (the throttle point), not the
critical composite temperature.

## ubus API

```
ubus call luci.thermal getSensors
ubus call luci.thermal getTemps '{"paths":["/sys/class/hwmon/hwmon1/temp1_input"]}'
```

`getSensors` returns the full topology once; `getTemps` returns readings only
and is what the poll loop uses. Paths passed to `getTemps` are validated
against the exact two sysfs attribute shapes this backend emits, so a prefix
like `/sys/class/hwmon/../../etc/passwd` is rejected rather than read.

## Layout

```
Makefile
htdocs/luci-static/resources/view/status/include/29_thermal.js   Overview block
htdocs/luci-static/resources/view/thermal/graph.js               graph page
htdocs/luci-static/resources/svg/thermal.svg                     graph template
root/usr/share/rpcd/ucode/luci.thermal                           ubus backend
root/usr/share/rpcd/acl.d/luci-app-thermal.json                  read-only ACL
root/usr/share/luci/menu.d/luci-app-thermal.json                 graph menu entry
po/                                                              translations
preview/preview.html                                             offline preview
preview/graph.html                                               offline preview
```

## Preview

Both previews run the **real** view code — fetched and executed unmodified —
against a fixture captured from live hardware, with `baseclass` and `rpc`
shimmed. Serve the package root:

```bash
python3 -m http.server 8799
```

Then visit `http://localhost:8799/preview/preview.html` for the Overview block
or `http://localhost:8799/preview/graph.html` for the graph page. Neither
needs a router or a network. `graph.html` has a load toggle that drives
synthetic temperatures past the trip points, which is how the threshold bands
and state labels were verified.

## Building

Drop into an OpenWrt buildroot with the LuCI feed:

```bash
make package/luci-app-thermal/compile V=s
```

## License

MIT
