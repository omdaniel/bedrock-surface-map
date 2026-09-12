@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> materials:array<Material>;
@group(0) @binding(2) var<storage,read> heights:HeightTree;
@group(1) @binding(0) var<storage,read> cells:array<Cell>;
@group(1) @binding(1) var<uniform> origin:vec4f;
@group(1) @binding(2) var out_image:texture_storage_2d<rgba8unorm,write>;
fn color(id:u32,tint:u32)->vec4f {let m=materials[id];return tint_color(m,m.average,tint,p.lighting.y);}
@compute @workgroup_size(8,8) fn overview(@builtin(global_invocation_id) id:vec3u) {
    if any(id.xy>=vec2u(256)){return;}let c=cells[id.y*256u+id.x];
    if c.covered==0u{textureStore(out_image,id.xy,vec4f(0));return;}
    var col=color(c.material,c.tint);
    if c.depth>0u {col=vec4f(mix(color(c.support,c.tint).rgb,water_color(p.lighting.y),1.0-exp(-f32(c.depth)*0.16))*mix(vec3f(0.85),vec3f(1.1),col.rgb),1.0);}
    else {col=vec4f(mix(col.rgb*0.7,col.rgb,col.a),1.0);}
    if c.overlay!=0u {let o=color(c.overlay,c.tint);col=vec4f(mix(col.rgb,o.rgb,o.a*0.65),1.0);}
    let at=origin.xy+vec2f(id.xy)-p.bounds.xy;
    let shade=surface_shadow(at,f32(bitcast<i32>(c.height))/16.0,vec2f(0),vec2f(1));
    var edge=vec2f(0);
    if c.depth==0u && materials[c.material].flags.x!=3.0 {edge=edge_relief(at,f32(bitcast<i32>(c.height))/16.0,vec2f(0),vec2f(1));}
    let sand=select(materials[c.material].flags.y,0.0,c.depth>0u);
    textureStore(out_image,id.xy,vec4f(compose_lighting(grade_color(col.rgb,p.lighting.y,sand),shade,edge),1));
}
