struct Params { camera:vec4f, screen:vec4f, bounds:vec4f }
struct Material { uv:vec4f, average:vec4f, flags:vec4f }
struct Cell { height:u32, material:u32, tint:u32, overlay:u32, depth:u32, support:u32, overlay_height:u32, covered:u32 }
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> materials:array<Material>;
@group(0) @binding(2) var<storage,read> shadows:array<f32>;
@group(1) @binding(0) var<storage,read> cells:array<Cell>;
@group(1) @binding(1) var<uniform> origin:vec4f;
@group(1) @binding(2) var out_image:texture_storage_2d<rgba8unorm,write>;
fn rgb(v:u32)->vec3f{return vec3f(f32((v>>16u)&255u),f32((v>>8u)&255u),f32(v&255u))/255.0;}
fn color(id:u32,tint:u32)->vec4f {let m=materials[id];var c=m.average;if m.flags.x==1.0 || m.flags.x==2.0 {c=vec4f(c.rgb*rgb(tint),c.a);}return c;}
@compute @workgroup_size(8,8) fn overview(@builtin(global_invocation_id) id:vec3u) {
    if any(id.xy>=vec2u(256)){return;}let c=cells[id.y*256u+id.x];
    if c.covered==0u{textureStore(out_image,id.xy,vec4f(0));return;}
    var col=color(c.material,c.tint);
    if c.depth>0u {col=vec4f(mix(color(c.support,c.tint).rgb,vec3f(0.08,0.38,0.64),1.0-exp(-f32(c.depth)*0.16))*mix(vec3f(0.85),vec3f(1.1),col.rgb),1.0);}
    else {col=vec4f(mix(col.rgb*0.7,col.rgb,col.a),1.0);}
    if c.overlay!=0u {let o=color(c.overlay,c.tint);col=vec4f(mix(col.rgb,o.rgb,o.a*0.65),1.0);}
    let at=vec2u(origin.xy+vec2f(id.xy)-p.bounds.xy);let shade=shadows[at.y*u32(p.bounds.z)+at.x];
    textureStore(out_image,id.xy,vec4f(col.rgb*(1.0-0.28*shade*p.screen.z),1));
}
