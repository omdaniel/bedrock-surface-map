@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> materials:array<Material>;
@group(0) @binding(2) var atlas:texture_2d<f32>;
@group(0) @binding(3) var atlas_sampler:sampler;
@group(0) @binding(6) var coarse_sampler:sampler;
@group(1) @binding(0) var<storage,read> words:array<u32>;
@group(1) @binding(1) var<uniform> draw:Draw;
@group(1) @binding(2) var shaded:texture_2d<f32>;
@group(1) @binding(3) var<storage,read> cached_status:array<u32,9>;
@group(2) @binding(0) var parent_shaded:texture_2d<f32>;
@group(2) @binding(1) var<storage,read> parent_status:array<u32,9>;
struct Vertex { @builtin(position) position:vec4f, @location(0) local:vec2f }
@vertex fn vs(@builtin(vertex_index) i:u32)->Vertex {
    let points=array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));
    let local=points[i]*128.0;
    let pixel=(draw.origin.xy+local*draw.origin.z)*p.camera.z;
    var v:Vertex;v.position=vec4f(pixel.x*2.0/p.camera.w,-pixel.y*2.0/p.screen.x,0,1);v.local=local;return v;
}
fn background()->vec3f {return vec3f(0.075,0.09,0.09);}
fn unknown(at:vec2f)->vec3f {
    let check=(u32(floor(at.x/8.0))+u32(floor(at.y/8.0)))&1u;
    return mix(background(),vec3f(0.13,0.15,0.15),f32(check));
}
@fragment fn fs(v:Vertex)->@location(0) vec4f {
    height_status=0u;
    let q=vec2u(clamp(floor(v.local),vec2f(0),vec2f(127)));
    let fractional=fract(v.local);let footprint=fwidth(v.local);
    let lo=max(vec2f(0),fractional-footprint*0.5);
    let hi=min(vec2f(1),fractional+footprint*0.5);
    var color=background();
    var blend_eligible=false;
    if draw.key.x==0 {
        let i=(q.y*128u+q.x)*8u;
        let c=Cell(words[i],words[i+1u],words[i+2u],words[i+3u],words[i+4u],words[i+5u],words[i+6u],words[i+7u]);
        if c.covered==1u {
            blend_eligible=true;
            let col=fine_color(c,fractional);
            let y=f32(bitcast<i32>(c.height))/16.0;
            let shade=surface_shadow(vec2f(q),y,lo,hi);
            var edge=vec2f(0);
            if c.depth==0u && materials[c.material].flags.x!=3.0 {edge=edge_relief(vec2f(q),y,lo,hi);}
            let sand=select(materials[c.material].flags.y,0.0,c.depth>0u);
            color=compose_lighting(grade_color(col.rgb,p.lighting.y,sand),shade,edge);
            let dist=min(fractional,vec2f(1)-fractional);
            let line=1.0-min(smoothstep(0.0,footprint.x*0.65,dist.x),smoothstep(0.0,footprint.y*0.65,dist.y));
            color*=1.0-line*0.15*p.screen.y*smoothstep(3.0,12.0,p.camera.z);
        } else if c.covered!=2u && c.covered!=3u {color=unknown(v.local);}
    } else {
        color=textureSampleLevel(shaded,coarse_sampler,(v.local+vec2f(1))/130.0,0.0).rgb;
        height_status=u32(draw.key.w)&8u;
        for(var i=0u;i<9u;i++){height_status|=cached_status[i];}
        let i=(q.y*128u+q.x)*6u;
        blend_eligible=((words[i+4u]>>16u)&255u)==255u && (words[i+4u]>>24u)==0u && (words[i+5u]&255u)==0u;
    }
    if blend_eligible {
        let distances=vec4f(v.local.x,128.0-v.local.x,v.local.y,128.0-v.local.y);
        let bands=vec4f(1)-smoothstep(vec4f(0),vec4f(2),distances);
        let weights=bands*draw.edges;
        let corners=vec4f(bands.x*bands.z,bands.y*bands.z,bands.x*bands.w,bands.y*bands.w)*draw.corners;
        let weight=max(max(max(weights.x,weights.y),max(weights.z,weights.w)),max(max(corners.x,corners.y),max(corners.z,corners.w)));
        if weight>0.0 {
            // Child parity is exact even for negative keys. The parent lookup
            // stays in [0,128] sample coordinates, never world-space f32.
            let parent_local=vec2f(draw.key.yz&vec2i(1))*64.0+v.local*0.5;
            color=mix(color,textureSampleLevel(parent_shaded,coarse_sampler,(parent_local+vec2f(1))/130.0,0.0).rgb,weight);
            for(var i=0u;i<9u;i++){height_status|=parent_status[i];}
            if (u32(draw.key.w)&16u)!=0u {height_status|=8u;}
        }
    }
    report_height_status();
    // Every cut member contributes background for empty/unknown coverage. It must
    // never discard and expose an opaque parent's ground through a child hole.
    return vec4f(color,1)*draw.origin.w;
}
