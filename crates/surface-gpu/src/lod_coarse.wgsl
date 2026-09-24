@group(0) @binding(0) var<storage,read> words:array<u32>;
@group(0) @binding(1) var dest:texture_storage_2d_array<rgba16float,write>;

@compute @workgroup_size(8,8) fn prepare(@builtin(global_invocation_id) id:vec3u) {
    if any(id.xy>=vec2u(130)){return;}
    let at=vec2u(clamp(vec2i(id.xy)-vec2i(1),vec2i(0),vec2i(127)));
    let i=(at.y*128u+at.x)*6u;
    let original=vec3u(words[i]&65535u,words[i]>>16u,words[i+1u]&65535u);
    let vivid=vec3u(words[i+1u]>>16u,words[i+2u]&65535u,words[i+2u]>>16u);
    let coverage=f32((words[i+4u]>>16u)&255u)/255.0;
    textureStore(dest,id.xy,0,vec4f(vec3f(original)/65535.0*coverage,coverage));
    textureStore(dest,id.xy,1,vec4f(vec3f(vivid)/65535.0*coverage,coverage));
}
