struct Build { slot:u32, source_level:u32, mip:u32, unused:u32 }
@group(0) @binding(0) var<storage,read> source:array<u32>;
@group(0) @binding(1) var<storage,read_write> nodes:array<vec2u>;
@group(0) @binding(2) var<uniform> build:Build;

fn signed16(v:u32)->i32 {return bitcast<i32>(v<<16u)>>16;}
fn offset(mip:u32)->u32 {return (65536u-(65536u>>(2u*mip)))/3u;}

@compute @workgroup_size(8,8) fn leaves(@builtin(global_invocation_id) id:vec3u) {
    if any(id.xy>=vec2u(128)){return;}
    let i=id.y*128u+id.x;
    var pair=vec2u(source[i],(source[i]&65535u)*65537u);
    if build.source_level!=0u {pair=vec2u(source[i*2u],source[i*2u+1u]);}
    nodes[build.slot*21845u+i]=pair;
}

@compute @workgroup_size(8,8) fn reduce(@builtin(global_invocation_id) id:vec3u) {
    let width=128u>>build.mip;
    if any(id.xy>=vec2u(width)){return;}
    let base=build.slot*21845u;
    let src=base+offset(build.mip-1u)+id.y*2u*width*2u+id.x*2u;
    let indices=array<u32,4>(src,src+1u,src+width*2u,src+width*2u+1u);
    var flags=0u;var low=32767;var high=-32768;
    for(var n=0u;n<4u;n++) {
        let child=nodes[indices[n]];
        flags|=child.x>>16u;
        if (child.x&65536u)!=0u {
            low=min(low,signed16(child.y));high=max(high,bitcast<i32>(child.y)>>16);
        }
    }
    nodes[base+offset(build.mip)+id.y*width+id.x]=vec2u(flags<<16u,(u32(low)&65535u)|(u32(high)<<16u));
}
