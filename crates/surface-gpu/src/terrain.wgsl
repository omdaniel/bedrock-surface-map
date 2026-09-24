@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> materials:array<Material>;
@group(0) @binding(2) var atlas:texture_2d<f32>;
@group(0) @binding(3) var atlas_sampler:sampler;
@group(0) @binding(4) var<storage,read> heights:HeightTree;
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
@fragment fn fs(v:Vertex)->@location(0) vec4f {
    let q=clamp(vec2u(v.local),vec2u(0),vec2u(255));let c=cells[q.y*256u+q.x];
    let fractional=fract(v.local);let footprint=fwidth(v.local);
    if p.camera.z < 1.0 {
        let lod=max(0.0,log2(1.0/p.camera.z));
        let col=textureSampleLevel(overview,overview_sampler,v.local/256.0,lod);
        if col.a<0.005{discard;}return vec4f(col.rgb/max(col.a,0.001),col.a);
    }
    if c.covered!=1u {discard;}
    var col=fine_color(c,fractional);
    let at=origin.xy+vec2f(q)-p.bounds.xy;
    let lo=max(vec2f(0),fractional-footprint*0.5);
    let hi=min(vec2f(1),fractional+footprint*0.5);
    let shade=surface_shadow(at,f32(bitcast<i32>(c.height))/16.0,lo,hi);
    var edge=vec2f(0);
    if c.depth==0u && materials[c.material].flags.x!=3.0 {edge=edge_relief(at,f32(bitcast<i32>(c.height))/16.0,lo,hi);}
    let sand=select(materials[c.material].flags.y,0.0,c.depth>0u);
    col=vec4f(compose_lighting(grade_color(col.rgb,p.lighting.y,sand),shade,edge),1.0);
    let dist=min(fractional,vec2f(1.0)-fractional);
    let line=1.0-min(smoothstep(0.0,footprint.x*0.65,dist.x),smoothstep(0.0,footprint.y*0.65,dist.y));
    let amount=line*0.15*p.screen.y*smoothstep(3.0,12.0,p.camera.z);
    return vec4f(col.rgb*(1.0-amount),1.0);
}
