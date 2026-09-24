@group(0) @binding(0) var accumulation:texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
    let points=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
    return vec4f(points[i],0,1);
}
@fragment fn fs(@builtin(position) pos:vec4f)->@location(0) vec4f {
    let color=textureLoad(accumulation,vec2i(pos.xy),0);
    return vec4f(color.rgb+vec3f(0.075,0.09,0.09)*max(0.0,1.0-color.a),1);
}
