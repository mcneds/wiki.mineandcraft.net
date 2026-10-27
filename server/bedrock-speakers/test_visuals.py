import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
from PIL import Image

spec = importlib.util.spec_from_file_location('converter', Path(__file__).with_name('convert_visuals.py'))
converter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(converter)
spec_patch = importlib.util.spec_from_file_location('patch_display', Path(__file__).with_name('patch_display.py'))
display_patch = importlib.util.module_from_spec(spec_patch)
spec_patch.loader.exec_module(display_patch)


class VisualConversionTests(unittest.TestCase):
    def test_native_display_override_preserves_other_displays_and_rebuilds_cleanly(self):
        with tempfile.TemporaryDirectory() as tmp:
            pack = Path(tmp) / 'display.mcpack'
            description = {'materials': {'default': 'armor_stand'}, 'textures': {'default': 'old'},
                           'geometry': {'default': 'geometry.display'}, 'animations': {'stable': 'animation.display.stable'},
                           'scripts': {'animate': ['debug']}}
            with zipfile.ZipFile(pack, 'w') as z:
                z.writestr('entity/item_display.entity.json', json.dumps({'minecraft:client_entity': {'description': description}}))
                z.writestr('manifest.json', json.dumps({'header': {'version': [1, 0, 0]}, 'modules': [{'version': [1, 0, 0]}]}))
                z.writestr('entity/block_display.entity.json', json.dumps({'minecraft:client_entity': {'description': {
                    'geometry': {'default': 'geometry.display'}, 'scripts': {'initialize': ['bad_old_alias;'],
                    'pre_animation': ['bad_long_expression;'], 'animate': ['interpolate']}}}}))
            models = {'indices': {'copperbedrock:test': 1}, 'geometries': {'copperbedrock:test': 'geometry.copperbedrock.native_test'}}
            display_patch.patch_pack(pack, models)
            with zipfile.ZipFile(pack) as z:
                first = {name: z.read(name) for name in z.namelist()}
                desc = json.loads(first['entity/item_display.entity.json'])['minecraft:client_entity']['description']
                self.assertEqual(desc['geometry']['default'], 'geometry.display')
                self.assertEqual(desc['geometry']['copper_1'], 'geometry.copperbedrock.native_test')
                block = json.loads(first['entity/block_display.entity.json'])['minecraft:client_entity']['description']
                self.assertEqual(block['geometry']['default'], 'geometry.display')
                self.assertEqual(block['scripts'], {'animate': ['stable']})
                self.assertNotIn('initialize', desc['scripts'])
                self.assertNotIn('pre_animation', desc['scripts'])
                self.assertEqual(desc['render_controllers'][0], {'controller.render.display': "q.property('copper:model') == 0"})
            display_patch.patch_pack(pack, models)
            with zipfile.ZipFile(pack) as z:
                self.assertEqual(first, {name: z.read(name) for name in z.namelist()})

    def test_model_geometry_textures_and_only_allocated_states_are_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            java, vanilla = root / 'java.zip', root / 'client.jar'
            image = Image.new('RGBA', (16, 16), (33, 66, 99, 255))
            png = io.BytesIO(); image.save(png, format='PNG')
            model = {'textures': {'surface': 'copper_speakers:block/test'}, 'elements': [{
                'from': [2, 1, 3], 'to': [10, 5, 15], 'faces': {
                    'north': {'texture': '#surface', 'uv': [1, 2, 13, 6]},
                    'up': {'texture': '#surface', 'uv': [1, 2, 13, 6]}}}]}
            with zipfile.ZipFile(java, 'w') as z:
                z.writestr('assets/copper_speakers/models/block/test.json', json.dumps(model))
                z.writestr('assets/copper_speakers/textures/block/test.png', png.getvalue())
                z.writestr('assets/copper_speakers/items/test.json', json.dumps({'model': {'type': 'minecraft:model', 'model': 'copper_speakers:block/test'}}))
                z.writestr('assets/polymer/models/block/empty.json', json.dumps({'elements': []}))
                z.writestr('assets/minecraft/blockstates/light_weighted_pressure_plate.json', json.dumps({'variants': {
                    'power=15': {'model': 'polymer:block/empty'}}}))
                z.writestr('assets/minecraft/blockstates/note_block.json', json.dumps({'variants': {
                    'instrument=harp,note=1,powered=true': {'model': 'copper_speakers:block/test', 'y': 90},
                    'instrument=harp,note=0,powered=false': {'model': 'minecraft:block/note_block'}}}))
            with zipfile.ZipFile(vanilla, 'w'): pass
            converter.convert(java, vanilla, root / 'output', root / 'icons')
            mappings = json.loads((root / 'output/copper-speakers-blocks.json').read_text())['blocks']['minecraft:note_block']
            self.assertTrue(mappings['only_override_states'])
            self.assertEqual(list(mappings['state_overrides']), ['instrument=harp,note=1,powered=true'])
            self.assertEqual(next(iter(mappings['state_overrides'].values()))['transformation']['rotation'], [0, 90, 0])
            all_blocks = json.loads((root / 'output/copper-speakers-blocks.json').read_text())['blocks']
            empty = all_blocks['minecraft:light_weighted_pressure_plate']['state_overrides']['power=15']
            self.assertEqual(empty['geometry'], 'geometry.copperbedrock.invisible_carrier')
            self.assertEqual(empty['material_instances']['*']['texture'], 'copperbedrock_empty')
            with zipfile.ZipFile(root / 'output/copper-speakers-bedrock.mcpack') as z:
                self.assertIsNone(z.testzip())
                atlas = Image.open(io.BytesIO(z.read('textures/copperbedrock/atlas.png')))
                self.assertEqual(atlas.getpixel((1, 2)), (33, 66, 99, 255))
                geometry_name = mappings['state_overrides']['instrument=harp,note=1,powered=true']['geometry']
                geometry = next(json.loads(z.read(n))['minecraft:geometry'][0] for n in z.namelist()
                                if n.startswith('models/') and json.loads(z.read(n))['minecraft:geometry'][0]['description']['identifier'] == geometry_name)
                cube = geometry['bones'][0]['cubes'][0]
                self.assertEqual(cube['origin'], [-2, 1, -5])
                self.assertEqual(cube['size'], [8, 4, 12])
                self.assertEqual(cube['uv']['north'], {'uv': [1, 2], 'uv_size': [12, 4]})
                self.assertEqual(cube['uv']['up'], {'uv': [13, 6], 'uv_size': [-12, -4]})
                transparent = Image.open(io.BytesIO(z.read('textures/copperbedrock/empty.png')))
                self.assertEqual(transparent.getextrema()[3], (0, 0))
                native = json.loads(z.read('models/entity/native_test.geo.json'))['minecraft:geometry'][0]
                self.assertEqual(native['bones'][0]['cubes'][0]['origin'], [-2, -7, -5])
                self.assertEqual(native['bones'][0]['pivot'], [0, 0, 0])
                manifest = json.loads(z.read('manifest.json'))
                self.assertEqual(manifest['header']['version'], [1, 2, 0])
                self.assertFalse(any(n.startswith('attachables/') for n in z.namelist()))
                self.assertEqual(mappings['geometry'], geometry_name)
                mesh_ids = {geo['description']['identifier'] for n in z.namelist() if n.endswith('.geo.json')
                            for geo in json.loads(z.read(n))['minecraft:geometry']}
                self.assertIn(empty['geometry'], mesh_ids)
                definitions = json.loads(z.read('sounds/sound_definitions.json'))['sound_definitions']
                self.assertIn('copperbedrock:buffered.record.cat', definitions)
                self.assertTrue(all(sound['stream'] is False for value in definitions.values() for sound in value['sounds']))


if __name__ == '__main__': unittest.main()
