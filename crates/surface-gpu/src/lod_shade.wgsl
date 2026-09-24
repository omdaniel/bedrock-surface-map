@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(6) var coarse_sampler:sampler;
@group(1) @binding(0) var<storage,read> words:array<u32>;
@group(1) @binding(1) var<uniform> draw:Draw;
@group(1) @binding(2) var coarse:texture_2d_array<f32>;
@group(1) @binding(3) var dest:texture_storage_2d<rgba16float,write>;
@group(1) @binding(4) var<storage,read_write> cached_status:atomic<u32>;

@compute @workgroup_size(8,8) fn shade_coarse(@builtin(global_invocation_id) id:vec3u) {
    if any(id.xy>=vec2u(130)){return;}
    height_status=0u;
    let q=clamp(vec2i(id.xy)-vec2i(1),vec2i(0),vec2i(127));
    let i=(u32(q.y)*128u+u32(q.x))*6u;
    // Until a sibling's lit border is ready, replicate this tile's own border.
    let summary=textureLoad(coarse,q+vec2i(1),i32(p.lighting.y),0);
    let y=signed_height(words[i+3u]);let flags=words[i+5u]>>16u;
    var shade=0.0;var edge=vec2f(0);
    if (flags&1u)!=0u {
        shade=surface_shadow(vec2f(q),y,vec2f(0),vec2f(1));
        if (flags&16u)==0u {edge=edge_relief(vec2f(q),y,vec2f(0),vec2f(1));}
    }
    let base=summary.rgb/max(summary.a,0.000001);
    let unknown_fraction=f32(words[i+5u]&255u)/255.0;
    let background=vec3f(0.075,0.09,0.09);
    let check=f32(((u32(q.x)/8u)+(u32(q.y)/8u))&1u);
    let unknown=mix(background,vec3f(0.13,0.15,0.15),check);
    let color=compose_lighting(base,shade,edge)*summary.a+background*max(0.0,1.0-summary.a-unknown_fraction)+unknown*unknown_fraction;
    textureStore(dest,id.xy,vec4f(color,1));atomicOr(&cached_status,height_status);report_height_status();
}
