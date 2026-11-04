@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> materials:array<Material>;
@group(0) @binding(2) var<storage,read> heights:HeightTree;
@group(1) @binding(0) var<storage,read> cells:array<Cell>;
@group(1) @binding(1) var<uniform> origin:vec4f;
@group(1) @binding(2) var out_image:texture_storage_2d<rgba8unorm,write>;
fn color(id:u32,tint:u32)->vec4f {let m=materials[id];return tint_color(m,m.average,tint,p.lighting.y);}
@compute @workgroup_size(8,8) fn overview(@builtin(global_invocation_id) id:vec3u) {
    let side=u32(origin.w);
    if any(id.xy>=vec2u(side)){return;}let c=cells[id.y*side+id.x];
    let world=origin.xy+vec2f(id.xy)*origin.z;
    let at=world_to_height(world);
    let footprint=vec2f(origin.z/max(1.0,p.relief.z));
    if (c.covered&0x80000000u)!=0u {
        // Six unmodified UNORM16/height/coverage words, then padding and the
        // type marker. None of these channels represents an exact material.
        let flags=c.support>>16u;
        let coverage=f32((c.depth>>16u)&255u)/255.0;
        if (flags&1u)==0u || coverage==0.0 {textureStore(out_image,id.xy,vec4f(0));return;}
        let original=vec3f(f32(c.height&65535u),f32(c.height>>16u),f32(c.material&65535u))/65535.0;
        let vivid=vec3f(f32(c.material>>16u),f32(c.tint&65535u),f32(c.tint>>16u))/65535.0;
        let y=f32(bitcast<i32>(c.overlay<<16u)>>16)/16.0;
        let shade=surface_shadow(at,y,vec2f(0),footprint);
        let water=f32((c.support>>8u)&255u)/max(1.0,f32((c.depth>>16u)&255u));
        let edge=sampled_relief(world+vec2f(origin.z*0.5),y,origin.z)*(1.0-water);
        // These colors were graded before averaging; do not grade twice.
        let base=mix(original,vivid,p.lighting.y);
        textureStore(out_image,id.xy,vec4f(compose_lighting(base,shade,edge)*coverage,coverage));
        return;
    }
    if (c.covered&255u)!=1u{textureStore(out_image,id.xy,vec4f(0));return;}
    var col=color(c.material,c.tint);
    if c.depth>0u {col=vec4f(mix(color(c.support,c.tint).rgb,water_color(p.lighting.y),1.0-exp(-f32(c.depth)*0.16))*mix(vec3f(0.85),vec3f(1.1),col.rgb),1.0);}
    else {col=vec4f(mix(col.rgb*0.7,col.rgb,col.a),1.0);}
    if c.overlay!=0u {let o=color(c.overlay,c.tint);col=vec4f(mix(col.rgb,o.rgb,o.a*0.65),1.0);}
    let shade=surface_shadow(at,f32(bitcast<i32>(c.height))/16.0,vec2f(0),footprint);
    var edge=vec2f(0);
    if c.depth==0u && materials[c.material].flags.x!=3.0 {
        if origin.z==1.0 && p.relief.z<=1.0 {
            edge=edge_relief(at,f32(bitcast<i32>(c.height))/16.0,vec2f(0),vec2f(1));
        } else {
            let y=f32(bitcast<i32>(c.height))/16.0;
            edge=sampled_relief(world,y,origin.z);
        }
    }
    let sand=select(materials[c.material].flags.y,0.0,c.depth>0u);
    let coverage=select(1.0,f32(c.covered>>8u)/(origin.z*origin.z),origin.z>1.0);
    textureStore(out_image,id.xy,vec4f(compose_lighting(grade_color(col.rgb,p.lighting.y,sand),shade,edge)*coverage,coverage));
}
