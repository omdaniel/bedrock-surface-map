struct Params { camera:vec4f, screen:vec4f, bounds:vec4f, lighting:vec4f }
struct Material { uv:vec4f, average:vec4f, flags:vec4f }
struct Cell { height:u32, material:u32, tint:u32, overlay:u32, depth:u32, support:u32, overlay_height:u32, covered:u32 }

fn rgb(v:u32)->vec3f {
    return vec3f(f32((v>>16u)&255u),f32((v>>8u)&255u),f32(v&255u))/255.0;
}
fn tint_color(m:Material, c:vec4f, tint:u32, vivid:f32)->vec4f {
    if m.flags.x!=1.0 && m.flags.x!=2.0 {return c;}
    let original=c.rgb*rgb(tint);
    // Normalize grayscale texture brightness so the biome palette defines the
    // base color, retaining texture contrast rather than multiplying it dark twice.
    let luminance=max(dot(m.average.rgb,vec3f(0.2126,0.7152,0.0722)),0.15);
    let base=select(vec3f(0.93),vec3f(0.64,0.82,0.56),m.flags.x==2.0)*rgb(tint);
    return vec4f(mix(original,clamp(c.rgb/luminance*base,vec3f(0),vec3f(1)),vivid),c.a);
}
fn grade_color(c:vec3f,vivid:f32)->vec3f {
    let l=dot(c,vec3f(0.2126,0.7152,0.0722));
    return clamp(mix(c,(vec3f(l)+(c-vec3f(l))*1.08)*1.04,vivid),vec3f(0),vec3f(1));
}
fn water_color(vivid:f32)->vec3f {return mix(vec3f(0.08,0.38,0.64),vec3f(0.055,0.33,0.72),vivid);}

// Integrate the lit area of one triangle, clipped by the side/NW horizons.
// This produces sub-block shadows without contour geometry or per-pixel ray walks.
fn lit_half(lo:vec2f,hi:vec2f,side:f32,diagonal:f32)->f32 {
    let x0=max(lo.x,side);let x1=min(hi.x,hi.y);let y0=max(lo.y,diagonal);
    if x1<=x0 || hi.y<=y0 {return 0.0;}
    let split=clamp(y0,x0,x1);
    return (split-x0)*(hi.y-y0)+(x1-split)*(hi.y-(split+x1)*0.5);
}
fn shadow_area(horizons:vec3f,y:f32,slope:f32,lo:vec2f,hi:vec2f)->f32 {
    let edge=(horizons-vec3f(y+0.0001))/slope;
    let lit=lit_half(lo,hi,edge.x,edge.z)+lit_half(lo.yx,hi.yx,edge.y,edge.z);
    return clamp(1.0-lit/max((hi.x-lo.x)*(hi.y-lo.y),0.00000001),0.0,1.0);
}
