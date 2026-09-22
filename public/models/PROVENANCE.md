# Spacecraft geometry provenance

Open geometry used by the Spacecraft page and the focused flight mark as
visual stand-ins for the synthetic spacecraft: `gpm.glb` for the fleet's bus
(`SIM-01`, `SIM-02`), `trmm.glb` for the closely-spaced object (`OBJ-1`), a
different spacecraft so it reads as not one of ours. The on-screen identities
stay synthetic; these files supply shape only. Retrieved 2026-09-21, unmodified
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
| `trmm.glb` | `3D Models/Tropical Rainfall Measuring Mission (TRMM)/Tropical Rainfall Measuring Mission (TRMM).glb` | `751bf23c` (2024-12-30) | 195,804 | `2d285eef6c6d16616ef97c0686900f874b08263faae31e8d6bcd6df2c81c6a1d` |

Both are Khronos glTF binaries (Blender glTF I/O 4.2.57) with Draco mesh
compression and no textures, so neither file carries any NASA insignia or
logotype. `gpm.glb`: 1 mesh, 48 named materials, about 283,000 triangles.
`trmm.glb` (retrieved 2026-09-22 from the same archive commit): 20 named
meshes, 23 materials, about 52,000 triangles.

## Credits on the archive pages

- GPM: <https://science.nasa.gov/3d-resources/global-precipitation-measurement/>, credited "NASA/Christopher R. Meaney".
- TRMM: the archive folder holds the model and a preview image and names no
  author; the archive as a whole is credited to NASA.

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

`OBJ-1` is the closely-spaced object in `SIM-01`'s plane: not one of the
fleet, so it should not look like one. The TRMM observatory, the alternate
from the prototype, is visibly a different spacecraft (a boxy bus with two
short arrays on booms, a dish on an arm, instruments at one end) and its file
carries named parts, so its subsystems could be mapped by name. It is a
retired civil science mission, not a defence asset.

## Subsystem mapping

MEGALITH's seven subsystems are attached in `src/lib/spacecraft3d/archive.ts`.
The archive file carries artist material names, not part names, and one
material spans several assemblies, so assignment is by region rather than by
material: every mesh is split into spatially connected components (vertices
welded by position, since the export shares no indices) and each component
is claimed by the region it sits in, so a highlight lights a body rather
than the faces that happen to share a material. Materials decide only the
two subsystems that really are surfaces. The regions were read off the
geometry with each material lit in turn and from a dump of the largest
components (scripts on the CANOPY branch `prototype/cad-variants`). Frame:
arrays along X, +Y zenith, the bus along Z with the aft module at +Z.

| Region | Reading | Subsystem |
| --- | --- | --- |
| Beyond the bus in X | Solar wings, yokes, hinges | power |
| `Reflector` material above the bus underside | Flat reflective panels on the bus | thermal |
| Above the bus near its middle, plus the thin column to the deck | High-gain dish and its mast | comms |
| Forward end above the deck | Spinning platform, dish, drum, tripod | payload |
| Under the bus | Radar boxes | payload |
| Small parts on the aft deck | Two identical boxes, a boom, fittings | adcs (star-tracker stand-in) |
| Aft module behind the adapter ring | All of its skins and the ring | propulsion |
| Forward compartment under the instrument; mid-body bay | Avionics stand-in | cdh |
| Everything else | Bus mid-body structure | never tinted |

The map is a reading of an artist's model, not an engineering drawing; it is
good enough to light the right body for a verdict and no more. When the file
cannot be loaded the page falls back to a procedural reference body
(`src/lib/spacecraft3d/parts.ts`).

### TRMM (`OBJ-1`)

`TRMM_MODEL` in `src/lib/spacecraft3d/archive.ts`. The file's twenty meshes
are named by material group, one material each, so assignment is by material
with a position check where one material serves two assemblies. Frame after
the spec's rotation: arrays along X, the dish at +Y, the bus along Z with the
microwave imager at +Z and the propulsion ring at -Z. Positions below are in
that frame after the fit to 6.4 units.

| Material | Reading | Subsystem |
| --- | --- | --- |
| `Panel 1`–`Panel 4`, `Solar_Parts`, `Solar_Small_Parts` | The four array panels, their fittings | power |
| `Sat/Solar_Arms`, beyond 1.0 in X | The array booms | power |
| `Sat/Solar_Arms`, within 1.0 in X | The dish arm | comms |
| `Satellite_Dish`, `Satellite_Arm_Parts` | The high-gain dish and its arm fittings | comms |
| `VIRS`, `CERES`, `Microwave_*` | The three instruments | payload |
| `Blue_Surfaces`, below -0.75 in Z | The ring and drum at the aft end | propulsion |
| `Grey_Surfaces`, thin in Z and large | The two flat sheets on the bus (radiator panels) | thermal |
| `Brown_Surface` | Equipment boxes on the bus panels (avionics stand-in) | cdh |
| `Orange Surface` | The wheel-shaped assembly on the bus side (reaction-wheel stand-in) | adcs |
| Everything else | Bus structure, fittings, surfaces | never tinted |

## Draco decoder

`public/draco/` holds the decoder from three.js 0.186.0
(`examples/jsm/libs/draco/gltf/`), MIT licence.
