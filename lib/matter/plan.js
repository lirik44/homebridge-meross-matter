// What a device shows over Matter is decided by what it already shows in HomeKit: every on/off
// service becomes an outlet. One of them and the device is an outlet; several and it becomes a
// composed device - a parent that carries the name and a child endpoint per socket, which is how
// Matter describes a power strip, and how Apple Home draws one tile that opens into buttons.
//
// Working it out from the HomeKit services rather than from the model means a channel hidden in
// the config is hidden in both ecosystems, and a device the plugin learns about later needs
// nothing here.

// What the Matter spec allows for a bridged device's name and its serial number. A longer one is
// not truncated anywhere - the accessory is refused, and quietly never appears.
export const NAME_MAX = 32

// A part's name travels in the descriptor's tag list, which Homebridge cuts at 64 characters.
export const PART_NAME_MAX = 64

/**
 * @param {string} name The name as HomeKit has it.
 * @param {number} [max] How much room there is for it.
 * @returns {string} The name, short enough to be accepted.
 */
export function trimName(name, max = NAME_MAX) {
  return String(name ?? '').trim().slice(0, max).trim()
}

/**
 * @param {string} [subtype] The HomeKit subtype of the service, where it has one.
 * @param {number} index Which service this is, counting from zero.
 * @param {Set<string>} taken The ids already handed out for this device.
 * @returns {string} An id for the child endpoint.
 */
function partIdFor(subtype, index, taken) {
  // The id ends up in the endpoint's identity, so it has to survive a restart unchanged - a part
  // whose id moves is a new device as far as a controller is concerned. The HomeKit subtype does
  // survive (`outlet-3` is channel three for as long as the device exists), so it is what we use.
  const base = String(subtype ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z\d-]+/g, '-')
    .replace(/^-+|-+$/g, '')

  let id = base || `outlet-${index + 1}`
  let attempt = 2
  while (taken.has(id)) {
    id = `${base || `outlet-${index + 1}`}-${attempt}`
    attempt += 1
  }

  taken.add(id)
  return id
}

/**
 * @param {string} [subtype] The HomeKit subtype of the service, where it has one.
 * @returns {number} The channel it stands for, for ordering; zero when it says nothing.
 */
export function channelOf(subtype) {
  const match = /(\d+)\s*$/.exec(String(subtype ?? ''))
  return match ? Number.parseInt(match[1], 10) : 0
}

/**
 * Works out what one accessory publishes over Matter.
 *
 * @param {object} device What the accessory shows in HomeKit: its name, its identity, and one
 *   entry per on/off service - `{ subtype, displayName, on, ref }`. Whatever `ref` holds is
 *   handed back untouched on the matching part, which is how the caller finds its way from a
 *   part back to the HomeKit service behind it.
 * @returns {object|null} The plan, or null when the accessory has nothing to publish.
 */
export function planFor(device) {
  const channels = (device?.channels ?? [])
    .filter(channel => channel && typeof channel === 'object')
    .slice()
    .sort((a, b) => channelOf(a.subtype) - channelOf(b.subtype))

  if (channels.length === 0) {
    return null
  }

  const taken = new Set()
  const parts = channels.map((channel, index) => ({
    id: partIdFor(channel.subtype, index, taken),
    displayName: trimName(channel.displayName || `Outlet ${index + 1}`, PART_NAME_MAX),
    subtype: channel.subtype,
    on: channel.on === true,
    ref: channel.ref,
  }))

  return {
    displayName: trimName(device.displayName || 'Meross device'),
    serialNumber: trimName(device.serialNumber || ''),
    model: trimName(device.model || 'Meross device'),
    // One socket is an outlet; several are a power strip, which Matter calls a composed device.
    composed: parts.length > 1,
    parts,
  }
}
