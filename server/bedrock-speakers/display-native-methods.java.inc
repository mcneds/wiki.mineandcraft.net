    private boolean nativeCopper;
    private static final java.util.Properties COPPER_MODELS = new java.util.Properties();
    static {
        try (var input = ItemDisplayEntity.class.getResourceAsStream("/copper-display-models.properties")) {
            if (input == null) throw new java.io.IOException("Missing Copper display model table");
            COPPER_MODELS.load(input);
        } catch (java.io.IOException failure) { throw new ExceptionInInitializerError(failure); }
    }

    private boolean showCopper(ItemData translated) {
        String identifier = translated.getDefinition().getIdentifier();
        if (!identifier.startsWith("copperbedrock:")) {
            if (nativeCopper) {
                nativeCopper = false;
                propertyManager.addProperty(new org.geysermc.geyser.entity.properties.type.IntProperty(
                        org.geysermc.geyser.api.util.Identifier.of("copper:model"), 255, 0, 0), 0);
            }
            return false;
        }
        nativeCopper = true;
        setInvisible(false);
        int model = Integer.parseInt(COPPER_MODELS.getProperty(identifier, "0"));
        propertyManager.addProperty(new org.geysermc.geyser.entity.properties.type.IntProperty(
                org.geysermc.geyser.api.util.Identifier.of("copper:model"), 255, 0, 0), model);
        metadata.put(EntityDataTypes.SCALE, model == 0 ? 0f : 1f);
        this.item = ItemData.AIR;
        // Native geometry has no armor-slot binding or equipment transform.
        var clear = new MobArmorEquipmentPacket();
        clear.setRuntimeEntityId(geyserId);
        clear.setHelmet(ItemData.AIR); clear.setChestplate(ItemData.AIR);
        clear.setLeggings(ItemData.AIR); clear.setBoots(ItemData.AIR); clear.setBody(ItemData.AIR);
        session.sendUpstreamPacket(clear);
        if (identifier.startsWith("copperbedrock:speaker_note_")) {
            var particle = new org.geysermc.geyser.shaded.org.cloudburstmc.protocol.bedrock.packet.SpawnParticleEffectPacket();
            particle.setIdentifier(identifier);
            particle.setUniqueEntityId(-1);
            particle.setPosition(position);
            particle.setDimensionId(session.getBedrockDimension().bedrockId());
            particle.setMolangVariablesJson(java.util.Optional.empty());
            session.sendUpstreamPacket(particle);
        }
        if (valid) {
            updateBedrockEntityProperties();
            moveAbsoluteRaw(position, yaw, pitch, headYaw, onGround, true);
        }
        return true;
    }
