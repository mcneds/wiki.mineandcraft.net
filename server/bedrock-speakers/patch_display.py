"""Apply narrowly scoped Copper display support to the pinned upstream source."""
import json
from pathlib import Path
import zipfile


def replace_once(text, before, after):
    if text.count(before) != 1:
        raise ValueError('Pinned upstream changed at: ' + before[:100])
    return text.replace(before, after, 1)


def patch_source(relative, text):
    if relative.endswith('/GeyserDisplayEntity.java'):
        text = replace_once(text,
            'registerDisplayProperties(event, Identifier.of("geyser:item_display"));',
            'registerDisplayProperties(event, Identifier.of("geyser:item_display"));\n'
            '            event.registerIntegerProperty(Identifier.of("geyser:item_display"), Identifier.of("copper:model"), 0, 255, 0);')
    if relative.endswith('/ItemDisplayEntity.java'):
        methods = Path(__file__).with_name('display-native-methods.java.inc').read_text()
        text = replace_once(text, '    private DisplayType displayType', methods + '\n    private DisplayType displayType')
        text = replace_once(text, '        this.item = item;', '        this.item = item;\n        if (showCopper(item)) return;')
        text = replace_once(text, '        if (config == null) return super.bedrockPosition();',
            '        if (nativeCopper) return position;\n        if (config == null) return super.bedrockPosition();')
        text = replace_once(text, '    public Vector3f bedrockRotation() {',
            '    public Vector3f bedrockRotation() {\n'
            '        if (nativeCopper) return Vector3f.from(0, getYaw(), getYaw());')
        text = replace_once(text, '    public void updateMainHand(GeyserSession session) {',
            '    public void updateMainHand(GeyserSession session) {\n        if (nativeCopper) return;')
    return text


def patch_pack(pack_path, models):
    with zipfile.ZipFile(pack_path) as archive:
        files = {name: archive.read(name) for name in archive.namelist() if not name.endswith('/')}
    name = 'entity/item_display.entity.json'
    entity = json.loads(files[name])
    desc = entity['minecraft:client_entity']['description']
    desc['materials']['copper'] = 'entity_alphatest'
    desc['textures']['copper'] = 'textures/copperbedrock/atlas'
    desc['geometry']['copper_empty'] = 'geometry.copperbedrock.empty'
    for identifier, index in models['indices'].items():
        desc['geometry']['copper_' + str(index)] = models['geometries'][identifier]
    desc['animations']['copper'] = 'animation.copperbedrock.display'
    desc['scripts']['animate'] = [
        {'interpolate': "q.property('copper:model') == 0 && v.interpolating"},
        {'stable': "q.property('copper:model') == 0 && !v.interpolating"},
        {'debug': "q.property('copper:model') == 0"},
        {'copper': "q.property('copper:model') > 0"}]
    desc['render_controllers'] = [
        {'controller.render.display': "q.property('copper:model') == 0"},
        {'controller.render.copperbedrock.display': "q.property('copper:model') > 0"}]
    files[name] = json.dumps(entity, separators=(',', ':')).encode()
    # The pinned pack queries nonexistent property aliases and its old long
    # interpolation expression fails the 26.60 Molang parser. The server already
    # supplies current transforms; use a small, stable animation path instead.
    for entity_name in ['entity/item_display.entity.json', 'entity/block_display.entity.json']:
        document = json.loads(files[entity_name])
        description = document['minecraft:client_entity']['description']
        description['scripts'].pop('initialize', None)
        description['scripts'].pop('pre_animation', None)
        description['scripts']['animate'] = ([
            {'stable': "q.property('copper:model') == 0"},
            {'debug': "q.property('copper:model') == 0"},
            {'copper': "q.property('copper:model') > 0"}]
            if 'item_display' in entity_name else ['stable'])
        files[entity_name] = json.dumps(document, separators=(',', ':')).encode()
    manifest = json.loads(files['manifest.json'])
    manifest['header']['version'] = [1, 2, 1]
    for module in manifest['modules']: module['version'] = [1, 2, 1]
    files['manifest.json'] = json.dumps(manifest).encode()
    with zipfile.ZipFile(pack_path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items(): archive.writestr(name, data)
