struct Params { camera: vec4f, screen: vec4f, bounds: vec4f }
struct Material { uv:vec4f, average:vec4f, flags:vec4f }
struct Cell { height:u32, material:u32, tint:u32, overlay:u32, depth:u32, support:u32, overlay_height:u32, covered:u32 }
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> materials:array<Material>;
@group(0) @binding(2) var atlas:texture_2d<f32>;
@group(0) @binding(3) var atlas_sampler:sampler;
@group(0) @binding(4) var<storage,read> shadows:array<f32>;
@group(1) @binding(0) var<storage,read> cells:array<Cell>;
@group(1) @binding(1) var<uniform> origin:vec4f;
@group(1) @binding(2) var overview:texture_2d<f32>;
@group(1) @binding(3) var overview_sampler:sampler;
struct Vertex { @builtin(position) position:vec4f, @location(0) local:vec2f }
@vertex fn vs(@builtin(vertex_index) i:u32)->Vertex {
    let points=array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));
    let local=points[i]*256.0; let world=origin.xy+local;
    let pixel=(world-p.camera.xy)*p.camera.z;
    var v:Vertex;v.position=vec4f(pixel.x*2.0/p.camera.w,-pixel.y*2.0/p.screen.x,0,1);v.local=local;return v;
}
fn rgb(v:u32)->vec3f{return vec3f(f32((v>>16u)&255u),f32((v>>8u)&255u),f32(v&255u))/255.0;}
fn material_color(id:u32,tint:u32,uv:vec2f)->vec4f {
    let m=materials[id];
    let lod=clamp(log2(32.0/p.camera.z),0.0,2.0);
    let tex=textureSampleLevel(atlas,atlas_sampler,m.uv.xy+uv*m.uv.zw,lod);
    var c=mix(m.average,tex,smoothstep(2.0,12.0,p.camera.z));
    if m.flags.x==1.0 || m.flags.x==2.0 {c=vec4f(c.rgb*rgb(tint),c.a);}
    return c;
}
@fragment fn fs(v:Vertex)->@location(0) vec4f {
    let q=clamp(vec2u(v.local),vec2u(0),vec2u(255));let c=cells[q.y*256u+q.x];
    let fractional=fract(v.local);let footprint=fwidth(v.local);
    if p.camera.z < 1.0 {
        let lod=max(0.0,log2(1.0/p.camera.z));
        let col=textureSampleLevel(overview,overview_sampler,v.local/256.0,lod);
        if col.a<0.005{discard;}return vec4f(col.rgb/max(col.a,0.001),col.a);
    }
    if c.covered==0u {discard;}
    var col=material_color(c.material,c.tint,fractional);
    if c.depth>0u {
        let support=material_color(c.support,c.tint,fractional).rgb;
        let water=vec3f(0.08,0.38,0.64);
        col=vec4f(mix(support,water,1.0-exp(-f32(c.depth)*0.16))*mix(vec3f(0.85),vec3f(1.1),col.rgb),1.0);
    } else {
        let m=materials[c.material];var base=m.average.rgb;
        if m.flags.x==1.0 || m.flags.x==2.0 {base*=rgb(c.tint);}
        col=vec4f(mix(base*0.7,col.rgb,col.a),1.0);
    }
    if c.overlay!=0u {let over=material_color(c.overlay,c.tint,fractional);col=vec4f(mix(col.rgb,over.rgb,over.a*0.65),1.0);}
    let world=origin.xy+vec2f(q);let at=vec2u(world-p.bounds.xy);
    let shade=shadows[at.y*u32(p.bounds.z)+at.x];col=vec4f(col.rgb*(1.0-0.28*shade*p.screen.z),1.0);
    let dist=min(fractional,vec2f(1.0)-fractional);
    let line=1.0-min(smoothstep(0.0,footprint.x*0.65,dist.x),smoothstep(0.0,footprint.y*0.65,dist.y));
    let amount=line*0.15*p.screen.y*smoothstep(3.0,12.0,p.camera.z);
    return vec4f(col.rgb*(1.0-amount),1.0);
}
