# Spacecraft geometry provenance

Open geometry used by the Spacecraft page's CAD prototype as a visual
stand-in for the synthetic spacecraft `SIM-01`. The on-screen identity stays
`SIM-01`; these files supply shape only. Retrieved 2026-09-21, unmodified
(byte-identical to the archive; hashes below).

## Source

NASA 3D Resources, the agency's public model archive, mirrored on GitHub:
<https://github.com/nasa/NASA-3D-Resources> (web interface
<https://science.nasa.gov/3d-resources/>). Archive `master` at retrieval:
`11ebb4ee043715aefbba6aeec8a61746fad67fa7` (2025-06-03).

## Files

| File | Archive path | Last archive commit | Bytes | SHA-256 |
| --- | --- | --- | --- | --- |
| `gpm.glb` | `3D Models/Global Precipitation Measurement/Global Precipitation Measurement.glb` | `875e9f9a` (2024-11-07) | 2,257,008 | `7068c880770bb2ac936e804a1af48e564c90b829ff884c405a4759e8da9e693e` |

Both are Khronos glTF binaries (Blender glTF I/O 4.2.57) with Draco mesh
compression and no textures, so neither file carries any NASA insignia or
logotype. `gpm.glb`: 1 mesh, 48 named materials, about 283,000 triangles.

## Credits on the archive pages

- GPM: <https://science.nasa.gov/3d-resources/global-precipitation-measurement/>, credited "NASA/Christopher R. Meaney".

## Terms

NASA's media usage guidelines
(<https://www.nasa.gov/nasa-brand-center/images-and-media/>): "NASA content
– images, audio, video, and media files used in the rendition of
3-dimensional models, such as texture maps and polygon data in any format –
generally are not subject to copyright in the United States." "NASA should
be acknowledged as the source of the material." "The NASA Insignia,
Logotype, identifiers, and imagery are not in the public domain." Use must
not "explicitly or implicitly convey NASA's endorsement". The archive README
states the assets "are free and without copyright".

Acknowledgement line rendered with the model: "Geometry: NASA 3D Resources
(public domain)". The mission name is kept out of the on-screen line so no
still names a real spacecraft; it is recorded here.

## Why this one

`SIM-01` in the scenarios is a LEO spacecraft with a ground link (transponder
chain, transmit amplifier, high-gain antenna), deployable solar arrays and a
battery, radiators, reaction wheels and star trackers, thrusters, an
avionics stack and a nadir sensor. The GPM Core Observatory is the closest
public-domain analogue: a LEO bus with two solar wings, a high-gain dish on a
boom for the ground link, instruments on the nadir deck and propulsion for
orbit maintenance. It is not a defence asset. (TRMM was evaluated as an
alternate during the prototype and not adopted; see the CANOPY branch
`prototype/cad-variants`.)

## Subsystem mapping

MEGALITH's seven subsystems are attached in `src/lib/spacecraft3d/archive.ts`.
The archive files carry no functional part names, so the map was read off
the geometry with each material lit in turn (scripts kept on the CANOPY branch `prototype/cad-variants`). Where the archive shares one material across assemblies,
the mesh is split into spatially connected components (vertices welded by
position, since the exports share no indices) and each component is assigned
by position or shape:

| GPM material | Reading | Subsystem |
| --- | --- | --- |
| `Dish-White-sm`, components above the bus | The dish at the top of the mast | comms (high-gain antenna) |
| `Dish-White-sm`, drum-height components | Instrument drum cover | payload |
| `Grey-sm-notex`, the one tall thin component | The antenna mast | comms |
| `White-sm`, long horizontal rods | Array yokes | power |
| `White-sm`, vertical rods | Mast segments | comms |
| `Solar-*`, `SolarPanel*` | Array cells and backs | power |
| `spinningdish-top`, `MainDishRails-smds`, `GreyLight-*`, `Silver-sm-bottombox*` | Spinning platform, its tripod, fittings, boxes under the bus | payload |
| `Mainbody-backsection-*` | Aft module behind the adapter ring | propulsion |
| `Reflector` | Large flat reflective side panels | thermal |
| `Mainbody-Black-sm`, forward-deck components | Two identical boxes | adcs (star-tracker stand-in) |
| `Gold-fl-instruments-3/4/5` | Small deck-mounted sensors | adcs |
| `Mainbody-Black-fl` | One distinct box on the forward face | cdh (avionics stand-in) |
| everything else | Structure, MLI, fittings | never tinted |

The map is a reading of an artist's model, not an engineering drawing; it is
good enough to light the right assembly for a verdict and no more. When the
file cannot be loaded the page falls back to a procedural reference body
(`src/lib/spacecraft3d/parts.ts`).

## Draco decoder

`public/draco/` holds the decoder from three.js 0.186.0
(`examples/jsm/libs/draco/gltf/`), MIT licence.
