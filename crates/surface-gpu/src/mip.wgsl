@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var dest:texture_storage_2d<rgba8unorm,write>;
@compute @workgroup_size(8,8) fn mip(@builtin(global_invocation_id) id:vec3u) {
    if any(id.xy>=textureDimensions(dest)){return;}
    let p=vec2i(id.xy*2u);
    let sum=textureLoad(source,p,0)+textureLoad(source,p+vec2i(1,0),0)+textureLoad(source,p+vec2i(0,1),0)+textureLoad(source,p+vec2i(1,1),0);
    textureStore(dest,id.xy,sum*0.25);
}
