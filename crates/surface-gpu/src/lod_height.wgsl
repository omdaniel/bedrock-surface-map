// Page table: 17 independent 256-entry hash tables; 128 slots in the GPU arena.
// Positions are relative to this draw tile, avoiding world-coordinate f32 loss.
struct Draw { origin:vec4f, key:vec4i, world:vec4f, edges:vec4f, corners:vec4f }
@group(0) @binding(4) var<storage,read> pages:array<vec4i>;
@group(0) @binding(5) var<storage,read> height_nodes:array<vec2u>;
struct Feedback { flags:atomic<u32>, missing:atomic<u32>, unknown:atomic<u32>, exhausted:atomic<u32> }
@group(0) @binding(7) var<storage,read_write> feedback:Feedback;
var<private> height_status:u32;
fn report_height_status() {
    if height_status==0u {return;}
    atomicOr(&feedback.flags,height_status);
    if (height_status&1u)!=0u {atomicAdd(&feedback.missing,1u);}
    if (height_status&2u)!=0u {atomicAdd(&feedback.unknown,1u);}
    if (height_status&4u)!=0u {atomicAdd(&feedback.exhausted,1u);}
}

fn signed_height(v:u32)->f32 {return f32(bitcast<i32>(v<<16u)>>16)/16.0;}
fn page_hash(key:vec2i)->u32 {
    return ((bitcast<u32>(key.x)*1664525u)^(bitcast<u32>(key.y)*1013904223u))&255u;
}
fn page_slot(key:vec2i,level:u32)->i32 {
    let h=page_hash(key);
    for(var probe=0u;probe<256u;probe++) {
        let entry=pages[level*256u+((h+probe)&255u)];
        if entry.z==0 {return -1;}
        if all(entry.xy==key) {return entry.z-1;}
    }
    return -1;
}
fn node_offset(mip:u32)->u32 {return (65536u-(65536u>>(2u*mip)))/3u;}
fn height_node(at:vec2f,mip:u32)->vec2u {
    if any(at<draw.world.xy) || any(at>=draw.world.zw) {return vec2u(8u<<16u,0u);}
    let delta=vec2i(floor(at/128.0));
    let slot=page_slot(draw.key.yz+delta,u32(draw.key.x));
    if slot<0 {return vec2u(32u<<16u,0u);}
    let local=vec2u(clamp(floor(at-vec2f(delta)*128.0),vec2f(0),vec2f(127)))>>vec2u(mip);
    return height_nodes[u32(slot)*21845u+node_offset(mip)+local.y*(128u>>mip)+local.x];
}
fn relief_neighbor(at:vec2i,fallback:f32)->f32 {
    let node=height_node(vec2f(at),0u);let flags=node.x>>16u;
    if (flags&32u)!=0u {height_status|=1u;}
    if (flags&4u)!=0u {height_status|=2u;}
    if (flags&1u)==0u {return fallback;}
    return signed_height(node.x);
}

// Max nodes only prune. Coarse occlusion always tests a representative leaf mean.
// Missing coverage or traversal exhaustion is propagated, never treated as sunlit.
fn ray_shadow(start:vec2f,y:f32)->f32 {
    let direction=p.lighting.zw;
    let cell_size=f32(1u<<u32(draw.key.x));
    let slope=p.screen.w*cell_size;
    let own=vec2i(floor(start));
    var distance=0.0;var mip=0u;
    for(var iterations=0u;iterations<8192u;iterations++) {
        let epsilon=0.0001;
        let position=start+direction*(distance+epsilon);
        let ray_y=y+distance*slope+0.0001;
        if ray_y>=p.bounds.x || any(position<draw.world.xy) || any(position>=draw.world.zw) {return 0.0;}
        let node=height_node(position,mip);let flags=node.x>>16u;
        if (flags&36u)!=0u {
            if mip>0u {mip-=1u;continue;}
            if (flags&32u)!=0u {height_status|=1u;return 0.0;}
            height_status|=2u;
        }
        if (flags&1u)!=0u && f32(bitcast<i32>(node.y)>>16)/16.0>ray_y {
            if mip>0u {mip-=1u;continue;}
            if any(vec2i(floor(position))!=own) && signed_height(node.x)>ray_y {return 1.0;}
        } else if mip<7u {
            let parent=height_node(position,mip+1u);
            if (parent.x&(36u<<16u))==0u && ((parent.x&65536u)==0u || f32(bitcast<i32>(parent.y)>>16)/16.0<=ray_y) {
                mip+=1u;continue;
            }
        }
        let span=f32(1u<<mip);
        let cell=floor(position/span);
        let edge=(cell+select(vec2f(0),vec2f(1),direction>vec2f(0)))*span;
        var exit_distance=vec2f(1e30);
        if direction.x!=0.0 {exit_distance.x=(edge.x-start.x)/direction.x;}
        if direction.y!=0.0 {exit_distance.y=(edge.y-start.y)/direction.y;}
        distance=max(min(exit_distance.x,exit_distance.y),distance+epsilon);
        mip=min(mip+1u,7u);
    }
    height_status|=4u;return 0.0;
}
fn surface_shadow(at:vec2f,y:f32,lo:vec2f,hi:vec2f)->f32 {
    if p.screen.z==0.0 || p.lighting.x==0.0 {return 0.0;}
    var sum=0.0;
    for(var v=0u;v<2u;v++) {
        for(var u=0u;u<2u;u++) {
            let uv=mix(lo,hi,(vec2f(f32(u),f32(v))+0.5)*0.5);
            sum+=ray_shadow(at+uv,y);
        }
    }
    return sum*0.25;
}
