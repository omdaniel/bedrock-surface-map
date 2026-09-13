struct HeightTree { levels:array<vec4u,32>, data:array<f32> }

fn maximum_height(level:u32, cell:vec2u)->f32 {
    let info=heights.levels[level];
    return heights.data[info.x+cell.y*info.y+cell.x];
}

// Conservative max-height nodes skip empty space; leaf tests intersect blocks.
// This acceleration structure is independent of sunlight and survives rotation.
fn ray_shadow(start:vec2f,y:f32)->f32 {
    let direction=p.lighting.zw;
    let root=heights.levels[31].w-1u;
    let epsilon=max(0.0001,max(p.bounds.z,p.bounds.w)*0.0000002);
    let own=vec2i(floor(start));
    var distance=0.0;
    var level=0u;
    loop {
        let position=start+direction*(distance+epsilon);
        if any(position<vec2f(0)) || any(position>=p.bounds.zw) {return 0.0;}
        let span=f32(1u<<level);
        let cell=vec2u(floor(position/span));
        let ray_y=y+distance*p.screen.w+0.0001;
        let high=maximum_height(level,cell);
        if high>ray_y {
            if level>0u {level-=1u;continue;}
            if any(vec2i(cell)!=own) {return 1.0;}
        } else if level<root {
            if maximum_height(level+1u,cell/2u)<=ray_y {level+=1u;continue;}
        }
        let edge=(vec2f(cell)+select(vec2f(0),vec2f(1),direction>vec2f(0)))*span;
        var exit_distance=vec2f(1e30);
        if direction.x!=0.0 {exit_distance.x=(edge.x-start.x)/direction.x;}
        if direction.y!=0.0 {exit_distance.y=(edge.y-start.y)/direction.y;}
        distance=max(min(exit_distance.x,exit_distance.y),distance+epsilon);
        level=min(level+1u,root);
    }
    return 0.0;
}

fn surface_shadow(at:vec2f,y:f32,lo:vec2f,hi:vec2f)->f32 {
    if p.screen.z==0.0 || p.lighting.x==0.0 {return 0.0;}
    // Stratified subpixel samples; overview mipmaps further filter whole-cell samples.
    var sum=0.0;
    for(var v=0u;v<2u;v++) {
        for(var u=0u;u<2u;u++) {
            let uv=mix(lo,hi,(vec2f(f32(u),f32(v))+0.5)*0.5);
            sum+=ray_shadow(at+uv,y);
        }
    }
    return sum*0.25;
}
