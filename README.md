<h1 align="center">Homebridge Meross — Matter fork</h1>

<p align="center">
    <a href="https://www.npmjs.com/package/homebridge">
        <img src="https://img.shields.io/badge/powered%20by-homebridge-blue" alt="powered by homebridge">
    </a>
    <a href="#local-control">
        <img src="https://img.shields.io/badge/control-local-brightgreen" alt="local control">
    </a>
    <a href="#the-sockets-over-matter">
        <img src="https://img.shields.io/badge/matter-outlets%20%7C%20power%20strips-brightgreen" alt="Matter: outlets and power strips">
    </a>
    <a href="LICENSE">
        <img src="https://img.shields.io/badge/license-MIT-lightgrey" alt="license MIT">
    </a>
</p>

---

This is a fork of [`homebridge-plugins/homebridge-meross`](https://github.com/homebridge-plugins/homebridge-meross),
which brings Meross devices into HomeKit and carries everything that talks to them — the cloud API, the
local HTTP protocol, the MQTT push, and the device knowledge behind a few hundred models. Everything that
plugin does, this one does.

What the fork adds is **Matter**, so the same sockets reach Alexa, SmartThings and Aqara as well as Apple
Home, and neither ecosystem has its own idea of what is switched on.

## The sockets over Matter

| Device | Over Matter |
| --- | --- |
| Plug, wall switch | An outlet: on/off |
| Power strip | One device with a socket per channel |

A power strip is published as a **composed device** — a parent that carries the name and a child endpoint
per socket, which is what Matter has for a strip and what makes Apple Home draw a single tile that opens
into a row of buttons, exactly as the strip's own HomeKit firmware does. Controllers that do not group
composed devices show the sockets side by side instead; nothing is lost either way.

What gets published is worked out from what a device already shows in HomeKit rather than from its model:
a channel hidden with `hideChannels` is hidden in both ecosystems, and a strip configured as separate
accessories arrives as separate outlets. The master channel is not published, because the plugin does not
show it in HomeKit either.

Lights, thermostats, garage doors, rollers and the sensors are HomeKit-only for now.

Both halves drive the same HomeKit characteristic, which is what keeps them in step: a Matter command is a
write to it, and everything the device reports — a poll, the Meross app, a finger on the socket itself —
arrives as a change on it and goes straight out to the controllers. A command asking for what a socket is
already doing is ignored: that is a controller keeping its own attributes in step, not a person pressing
anything, and obeying it has the two ecosystems talking to each other in circles.

Matter is on wherever the Homebridge bridge running this plugin has Matter enabled; that is the real
opt-in. `disableMatter` leaves everything out of Matter without touching HomeKit.

## Local control

Nothing above needs the cloud in steady state. The account is used once at startup, for the device list
and the key each request is signed with; from then on the plugin talks to the device over plain HTTP on
the local network and polls it every few seconds.

To pin a device to local control, give it an address:

```json
{
  "multiDevices": [
    {
      "serialNumber": "<the uuid from the meross app>",
      "name": "Power Strip",
      "deviceUrl": "192.168.1.111",
      "showAs": "power-strip",
      "connection": "local"
    }
  ]
}
```

Without `deviceUrl` the plugin starts on the cloud and moves to the local address as soon as the device
reports one, which is upstream's behaviour and works fine — it just means the first few seconds go through
a datacentre.

## Installation

The package name is unchanged, so this installs over the upstream plugin and your existing configuration
and HomeKit accessories carry on as they were:

```
npm --prefix /var/lib/homebridge install github:lirik44/homebridge-meross-matter
```

Then enable Matter for the child bridge this plugin runs in, and add that bridge to your Matter app with
the pairing code Homebridge logs at startup.

## Configuration

Every option from the upstream plugin works as documented in its
[wiki](https://github.com/homebridge-plugins/homebridge-meross/wiki/Configuration). This fork adds one:

| Option | Default | What it does |
| --- | --- | --- |
| `disableMatter` | `false` | Publish nothing over Matter, whatever the bridge allows |

## Development

```
npm install
npm test
npm run lint
```

The tests cover what can be checked without hardware: what each kind of device becomes over Matter, the
names and identities a composed device carries, and the path a command takes in either direction —
including the one that would otherwise have the two ecosystems answering each other.

## Credits

- [homebridge-plugins/homebridge-meross](https://github.com/homebridge-plugins/homebridge-meross) — the
  plugin this fork is based on, and everything that talks to the devices
- [@Apollon77](https://github.com/Apollon77) and [@colthreepv](https://github.com/colthreepv) — the
  [meross-cloud](https://github.com/Apollon77/meross-cloud) library the cloud side grew out of
- [@simont77](https://github.com/simont77) and [@NorthernMan54](https://github.com/NorthernMan54) —
  [Fakegato](https://github.com/simont77/fakegato-history), which draws the history graphs
- [homebridge/homebridge](https://github.com/homebridge/homebridge) — Homebridge, and its Matter support

## Disclaimer

Neither this fork nor the plugin it comes from is affiliated with Meross. Use it at your own risk; see the
licence.

## License

MIT, same as the upstream project.
