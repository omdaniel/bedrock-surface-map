// Both renderers use this exact atlas/tint/water/overlay path.
fn material_color(id:u32,tint:u32,uv:vec2f)->vec4f {
    let m=materials[id];
    let lod=clamp(log2(32.0/p.camera.z),0.0,2.0);
    let tex=textureSampleLevel(atlas,atlas_sampler,m.uv.xy+uv*m.uv.zw,lod);
    let c=mix(m.average,tex,smoothstep(2.0,12.0,p.camera.z));
    return tint_color(m,c,tint,p.lighting.y);
}
fn fine_color(c:Cell,fractional:vec2f)->vec4f {
    var col=material_color(c.material,c.tint,fractional);
    if c.depth>0u {
        let support=material_color(c.support,c.tint,fractional).rgb;
        col=vec4f(mix(support,water_color(p.lighting.y),1.0-exp(-f32(c.depth)*0.16))*mix(vec3f(0.85),vec3f(1.1),col.rgb),1.0);
    } else {
        let m=materials[c.material];let base=tint_color(m,m.average,c.tint,p.lighting.y).rgb;
        col=vec4f(mix(base*0.7,col.rgb,col.a),1.0);
    }
    if c.overlay!=0u {let over=material_color(c.overlay,c.tint,fractional);col=vec4f(mix(col.rgb,over.rgb,over.a*0.65),1.0);}
    return col;
}
