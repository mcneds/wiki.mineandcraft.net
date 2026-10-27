#!/usr/bin/env python3
"""Convert this server's Copper Speakers cuboids and Polymer carriers to Bedrock.

Uses original Java models/textures, including vanilla textures from --client-jar.
Requires Pillow. Outputs a pack and Geyser mappings; never edits the source pack.
"""
import argparse
import copy
import hashlib
import io
import json
import math
from pathlib import Path
import re
import uuid
import zipfile
from PIL import Image, ImageChops


def identifier_path(identifier, folder, suffix):
    namespace, path = identifier.split(':', 1)
    return f'assets/{namespace}/{folder}/{path}{suffix}'


def default_uv(face, start, end):
    x, y, z = start
    X, Y, Z = end
    return {'down': [x, 16-Z, X, 16-z], 'up': [x, z, X, Z],
            'north': [16-X, 16-Y, 16-x, 16-y], 'south': [x, 16-Y, X, 16-y],
            'west': [z, 16-Y, Z, 16-y], 'east': [16-Z, 16-Y, 16-z, 16-y]}[face]


def convert(java_pack, client_jar, output, icons):
    output.mkdir(parents=True, exist_ok=True)
    files, textures, models = {}, {}, {}
    def write(name, value):
        files[name] = json.dumps(value, separators=(',', ':')).encode()
    with zipfile.ZipFile(java_pack) as assets, zipfile.ZipFile(client_jar) as vanilla:
        def read(name):
            try: return assets.read(name)
            except KeyError:
                # The 0.2.0 release references this sprite but omits the PNG.
                # Use Minecraft's own note silhouette with the mod's eight tints.
                if name == 'assets/copper_speakers/textures/item/speaker_note.png':
                    name = 'assets/minecraft/textures/particle/note.png'
                return vanilla.read(name)
        def texture(identifier):
            if identifier not in textures:
                textures[identifier] = Image.open(io.BytesIO(read(identifier_path(identifier, 'textures', '.png')))).convert('RGBA')
            return identifier
        def model(identifier):
            if identifier not in models:
                own = json.loads(read(identifier_path(identifier, 'models', '.json')))
                parent = own.get('parent', '')
                base = model(parent) if parent and parent not in ('minecraft:block/block', 'minecraft:item/generated', 'minecraft:item/handheld') else {}
                value = {**copy.deepcopy(base), **own}
                value['textures'] = {**base.get('textures', {}), **own.get('textures', {})}
                models[identifier] = value
            return models[identifier]
        def resolve(value, slots):
            seen = set()
            while value.startswith('#'):
                if value in seen: raise ValueError('Cyclic texture reference')
                seen.add(value)
                value = slots[value[1:]]
            texture(value)
            return value

        # Collect the models referenced by the exact Polymer pack's state allocation.
        carrier_states = {}
        for name in assets.namelist():
            if not name.startswith('assets/minecraft/blockstates/') or not name.endswith('.json'): continue
            states = {}
            for state, variants in json.loads(assets.read(name)).get('variants', {}).items():
                variants = variants if isinstance(variants, list) else [variants]
                if len(variants) != 1: continue
                variant = variants[0]
                if variant['model'].startswith('copper_speakers:') or variant['model'] == 'polymer:block/empty':
                    states[state] = variant
                    model(variant['model'])
            if states: carrier_states['minecraft:' + Path(name).stem] = states
        item_models = {}
        for name in assets.namelist():
            if not name.startswith('assets/copper_speakers/items/') or not name.endswith('.json'): continue
            item_name = Path(name).stem
            definition = json.loads(assets.read(name))['model']
            if definition['type'] == 'minecraft:select':
                definition = next(row['model'] for row in definition['cases'] if row['when'] == 'fixed')
            if definition['type'] != 'minecraft:model': raise ValueError('Unsupported item model: ' + name)
            value = copy.deepcopy(model(definition['model']))
            # Generated notes are flat sprites in Java; keep their authored tint.
            if 'elements' not in value and 'layer0' in value['textures']:
                value['elements'] = [{'from': [0, 0, 7.99], 'to': [16, 16, 8.01],
                                      'faces': {face: {'texture': '#layer0', 'uv': [0, 0, 16, 16]} for face in ('north', 'south')}}]
            tints = definition.get('tints', [])
            if tints and tints[0].get('type') == 'minecraft:constant':
                tint = tints[0]['value'] & 0xffffff
                original = resolve(value['textures']['layer0'], value['textures'])
                image = textures[original]
                color = Image.new('RGBA', image.size, ((tint >> 16) & 255, (tint >> 8) & 255, tint & 255, 255))
                key = 'copperbedrock:tint/' + item_name
                textures[key] = ImageChops.multiply(image, color)
                value['textures']['layer0'] = key
            item_models[item_name] = value
        # Resolve all face textures before constructing one atlas for attachables.
        for value in [*models.values(), *item_models.values()]:
            for cube in value.get('elements', []):
                if cube.get('rotation'): raise ValueError('Rotated cuboids need an explicit conversion')
                for face in cube['faces'].values(): resolve(face['texture'], value['textures'])
        texture_ids = sorted(textures)
        cell = max(16, max((max(image.size) for image in textures.values()), default=16))
        side = 2 ** math.ceil(math.log2(max(cell, math.ceil(math.sqrt(len(textures) + 1)) * cell)))
        atlas = Image.new('RGBA', (side, side))
        origins = {}
        for index, key in enumerate(texture_ids):
            image = textures[key]
            origins[key] = ((index % (side // cell)) * cell, (index // (side // cell)) * cell)
            atlas.paste(image, origins[key])
        png = io.BytesIO(); atlas.save(png, format='PNG')
        files['textures/copperbedrock/atlas.png'] = png.getvalue()
        geometry_ids, native_geometries = {}, {}
        def geometry(key, value):
            if key in geometry_ids: return geometry_ids[key]
            safe = re.sub('[^a-z0-9_]', '_', key.lower())
            geometry_id = 'geometry.copperbedrock.' + safe
            cubes = []
            for cube in value.get('elements', []):
                start, end = cube['from'], cube['to']
                faces = {}
                for direction, face in cube['faces'].items():
                    if face.get('rotation', 0): raise ValueError('Rotated face UV needs an explicit conversion')
                    key_texture = resolve(face['texture'], value['textures'])
                    x, y = origins[key_texture]
                    image = textures[key_texture]
                    u, v, U, V = face.get('uv', default_uv(direction, start, end))
                    if direction in ('up', 'down'):
                        u, U, v, V = U, u, V, v
                    faces[direction] = {'uv': [x + u * image.width / 16, y + v * image.height / 16],
                                        'uv_size': [(U-u) * image.width / 16, (V-v) * image.height / 16]}
                cubes.append({'origin': [8-end[0], start[1], start[2]-8],
                              'size': [end[i]-start[i] for i in range(3)], 'uv': faces})
            write(f'models/entity/{safe}.geo.json', {'format_version': '1.12.0', 'minecraft:geometry': [{
                'description': {'identifier': geometry_id, 'texture_width': side, 'texture_height': side,
                                'visible_bounds_width': 4, 'visible_bounds_height': 4, 'visible_bounds_offset': [0, 1, 0]},
                'bones': [{'name': 'root', 'pivot': [0, 8, 0], 'cubes': cubes}]}]})
            geometry_ids[key] = geometry_id
            return geometry_id
        def native_geometry(name, value):
            source_id = geometry('native_' + name, value)
            safe = re.sub('[^a-z0-9_]', '_', ('native_' + name).lower())
            document = json.loads(files[f'models/entity/{safe}.geo.json'])
            bone = document['minecraft:geometry'][0]['bones'][0]
            bone['name'] = 'geyser'
            bone['pivot'] = [0, 0, 0]
            for cube in bone['cubes']: cube['origin'][1] -= 8
            write(f'models/entity/{safe}.geo.json', document)
            return source_id
        blocks = {}
        invisible_id = 'geometry.copperbedrock.invisible_carrier'
        write('models/blocks/invisible_carrier.geo.json', {'format_version': '1.12.0', 'minecraft:geometry': [{
            'description': {'identifier': invisible_id, 'texture_width': 16, 'texture_height': 16},
            'bones': [{'name': 'root', 'pivot': [0, 0, 0], 'cubes': [
                {'origin': [-8, 0, -8], 'size': [16, 16, 16], 'uv': [0, 0]}]}]}]})
        for block, states in sorted(carrier_states.items()):
            overrides = {}
            for state, variant in states.items():
                if variant['model'] == 'polymer:block/empty':
                    # Bedrock rejects a custom block geometry with no cubes.
                    # A valid full cube with a transparent material is invisible.
                    overrides[state] = {'geometry': invisible_id, 'material_instances': {
                        '*': {'texture': 'copperbedrock_empty', 'render_method': 'alpha_test'}}}
                else:
                    overrides[state] = {'geometry': geometry(variant['model'], model(variant['model'])),
                                        'transformation': {'rotation': [-variant.get('x', 0), variant.get('y', 0), variant.get('z', 0)]}}
            blocks[block] = {'name': 'copperbedrock_' + block.split(':')[1], 'only_override_states': True,
                             # An implicit full-block base retains unit-cube
                             # culling even when permutations use thin meshes.
                             'geometry': next(iter(overrides.values()))['geometry'],
                             'material_instances': {'*': {'texture': 'copperbedrock_atlas', 'render_method': 'alpha_test',
                                                           'face_dimming': True, 'ambient_occlusion': True}},
                             'state_overrides': overrides}
        empty = io.BytesIO(); Image.new('RGBA', (16, 16)).save(empty, format='PNG')
        files['textures/copperbedrock/empty.png'] = empty.getvalue()
        write('textures/terrain_texture.json', {'resource_pack_name': 'copperbedrock', 'texture_name': 'atlas.terrain',
                                                'texture_data': {'copperbedrock_atlas': {'textures': 'textures/copperbedrock/atlas'},
                                                                 'copperbedrock_empty': {'textures': 'textures/copperbedrock/empty'}}})
        items, item_textures = {}, {}
        display_models = {}
        for name, value in sorted(item_models.items()):
            fallback = {'speaker': 'note_block', 'copper_wire': 'redstone', 'wall_plate': 'item_frame'}.get(name, 'paper')
            identifier = 'copperbedrock:' + name
            if not name.startswith('speaker_note_'):
                display_models[identifier] = len(display_models) + 1
                native_geometries[identifier] = native_geometry(name, value)
            icon = 'copperbedrock_' + name
            items.setdefault('minecraft:' + fallback, []).append({
                'type': 'definition', 'model': 'copper_speakers:' + name, 'bedrock_identifier': identifier,
                'display_name': name.replace('_', ' ').title(), 'bedrock_options': {'icon': icon}})
            icon_source = icons / (name + '.png')
            if icon_source.is_file(): files['textures/items/' + icon + '.png'] = icon_source.read_bytes()
            else:
                image = next((textures[resolve(face['texture'], value['textures'])]
                              for cube in value.get('elements', []) for face in cube['faces'].values()), Image.new('RGBA', (16, 16)))
                data = io.BytesIO(); image.save(data, format='PNG');files['textures/items/' + icon + '.png'] = data.getvalue()
            item_textures[icon] = {'textures': 'textures/items/' + icon}
            # Inventory/held items use their icons. World displays use native
            # meshes; unbound attachables render at the wrong equipment origin.
            if name.startswith('speaker_note_'):
                sprite = textures[value['textures']['layer0']]
                data = io.BytesIO(); sprite.save(data, format='PNG')
                files['textures/particle/' + name + '.png'] = data.getvalue()
                write('particles/' + name + '.json', {'format_version': '1.10.0', 'particle_effect': {
                    'description': {'identifier': 'copperbedrock:' + name, 'basic_render_parameters': {
                        'material': 'particles_alpha', 'texture': 'textures/particle/' + name}},
                    'components': {'minecraft:emitter_rate_instant': {'num_particles': 1},
                        'minecraft:emitter_lifetime_once': {'active_time': 0.01},
                        'minecraft:emitter_shape_point': {'direction': [0, 1, 0]},
                        'minecraft:particle_lifetime_expression': {'max_lifetime': 0.8},
                        'minecraft:particle_initial_speed': 0.25,
                        'minecraft:particle_motion_dynamic': {},
                        'minecraft:particle_appearance_billboard': {
                            'size': ['0.16 * math.min(1, (0.8-v.particle_age)/0.2)', '0.16 * math.min(1, (0.8-v.particle_age)/0.2)'],
                            'facing_camera_mode': 'lookat_xyz', 'uv': {'texture_width': sprite.width,
                                'texture_height': sprite.height, 'uv': [0, 0], 'uv_size': list(sprite.size)}}}}})
        # Native display geometry bypasses equipment-slot transforms entirely.
        # Index zero leaves upstream GeyserDisplayEntity rendering in control.
        write('render_controllers/copper_display.json', {'format_version': '1.8.0', 'render_controllers': {
            'controller.render.copperbedrock.display': {
                'arrays': {'geometries': {'Array.models': ['Geometry.copper_empty', *['Geometry.copper_' + str(i) for i in display_models.values()]]}},
                'geometry': "Array.models[q.property('copper:model')]", 'materials': [{'*': 'Material.copper'}],
                'textures': ['Texture.copper']}}})
        write('models/entity/native_empty.geo.json', {'format_version': '1.12.0', 'minecraft:geometry': [{
            'description': {'identifier': 'geometry.copperbedrock.empty', 'texture_width': 16, 'texture_height': 16},
            'bones': [{'name': 'geyser', 'pivot': [0, 0, 0]}]}]})
        write('animations/copper_display.json', {'format_version': '1.8.0', 'animations': {
            'animation.copperbedrock.display': {'loop': True, 'bones': {'geyser': {
                'position': ["-q.property('geyser:t_x') * 1.6", "q.property('geyser:t_y') * 1.6", "q.property('geyser:t_z') * 1.6"],
                'scale': ["q.property('geyser:s_x')", "q.property('geyser:s_y')", "q.property('geyser:s_z')"]}}}}})
        # Standalone wall-plate actors use the same authored fixed-context mesh.
        wall = native_geometries.get('copperbedrock:wall_plate')
        if wall:
            write('entity/wall_plate.entity.json', {'format_version': '1.10.0', 'minecraft:client_entity': {'description': {
                'identifier': 'copperbedrock:wall_plate', 'materials': {'default': 'entity_alphatest'},
                'textures': {'default': 'textures/copperbedrock/atlas'}, 'geometry': {'default': wall},
                'render_controllers': ['controller.render.copperbedrock']}}})
        write('render_controllers/copperbedrock.json', {'format_version': '1.8.0', 'render_controllers': {
            'controller.render.copperbedrock': {'geometry': 'Geometry.default', 'materials': [{'*': 'Material.default'}],
                                               'textures': ['Texture.default']}}})
        write('textures/item_texture.json', {'resource_pack_name': 'copperbedrock', 'texture_name': 'atlas.items', 'texture_data': item_textures})
        vanilla_records = json.loads(Path(__file__).with_name('bedrock-records.json').read_text())
        sound_definitions = {}
        for event, definition in vanilla_records.items():
            value = copy.deepcopy(definition)
            value.pop('min_distance', None)
            value.pop('__use_legacy_max_distance', None)
            for sound in value['sounds']: sound['stream'] = False
            sound_definitions['copperbedrock:buffered.' + event] = value
        write('sounds/sound_definitions.json', {'format_version': '1.14.0', 'sound_definitions': sound_definitions})
        write('manifest.json', {'format_version': 2, 'header': {'name': 'Copper Speakers for Bedrock',
            'description': 'Copper Speakers 0.2.0 models, converted from the server pack',
            'uuid': str(uuid.uuid5(uuid.NAMESPACE_DNS, 'copper-bedrock.mineandcraft.net')),
            'version': [1, 2, 0], 'min_engine_version': [1, 26, 60]},
            'modules': [{'type': 'resources', 'uuid': str(uuid.uuid5(uuid.NAMESPACE_DNS, 'copper-bedrock.mineandcraft.net.resources')), 'version': [1, 2, 0]}]})
        target = output / 'copper-speakers-bedrock.mcpack'
        with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as pack:
            for name, data in sorted(files.items()): pack.writestr(name, data)
        (output / 'copper-speakers-blocks.json').write_text(json.dumps({'format_version': 1, 'blocks': blocks}, indent=2))
        (output / 'copper-speakers-items.json').write_text(json.dumps({'format_version': 2, 'items': items}, indent=2))
        (output / 'display-models.json').write_text(json.dumps({'indices': display_models, 'geometries': native_geometries}, indent=2))
        print(f'Converted {sum(len(v) for v in carrier_states.values())} carrier states, {len(item_models)} items; pack {target.stat().st_size} bytes')
        print('Source pack SHA256:', hashlib.sha256(java_pack.read_bytes()).hexdigest())


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--java-pack', type=Path, required=True)
    parser.add_argument('--client-jar', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--icons', type=Path, required=True)
    args = parser.parse_args()
    convert(args.java_pack, args.client_jar, args.output, args.icons)
