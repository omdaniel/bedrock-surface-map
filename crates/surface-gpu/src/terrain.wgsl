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
fn material_color(id:u32,tint:u32,uv:vec2f)->vec4f {
    let m=materials[id];
    let lod=clamp(log2(32.0/p.camera.z),0.0,2.0);
    let tex=textureSampleLevel(atlas,atlas_sampler,m.uv.xy+uv*m.uv.zw,lod);
    let c=mix(m.average,tex,smoothstep(2.0,12.0,p.camera.z));
    return tint_color(m,c,tint,p.lighting.y);
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
    var col=material_color(c.material,c.tint,fractional);
    if c.depth>0u {
        let support=material_color(c.support,c.tint,fractional).rgb;
        let water=water_color(p.lighting.y);
        col=vec4f(mix(support,water,1.0-exp(-f32(c.depth)*0.16))*mix(vec3f(0.85),vec3f(1.1),col.rgb),1.0);
    } else {
        let m=materials[c.material];let base=tint_color(m,m.average,c.tint,p.lighting.y).rgb;
        col=vec4f(mix(base*0.7,col.rgb,col.a),1.0);
    }
    if c.overlay!=0u {let over=material_color(c.overlay,c.tint,fractional);col=vec4f(mix(col.rgb,over.rgb,over.a*0.65),1.0);}
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
