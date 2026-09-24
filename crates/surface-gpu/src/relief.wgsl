// Exact footprint coverage of two axis-aligned bands. Equal-height blocks have
// no interior seam. At 4 pixels/block a 0.25-block band is one pixel wide.
fn edge_relief(at:vec2f,y:f32,lo:vec2f,hi:vec2f)->vec2f {
    if p.relief.x==0.0 {return vec2f(0);}
    let direction=p.lighting.zw;
    let step=select(vec2i(-1),vec2i(1),direction>=vec2f(0));
    let neighbor=vec2f(relief_neighbor(vec2i(at)+vec2i(step.x,0),y),relief_neighbor(vec2i(at)+vec2i(0,step.y),y));
    let weight=abs(direction)/max(max(abs(direction.x),abs(direction.y)),0.0001);
    let band_lo=select(vec2f(0),vec2f(1.0-p.relief.y),direction>=vec2f(0));
    let band_hi=band_lo+vec2f(p.relief.y);
    let coverage=clamp((min(hi,band_hi)-max(lo,band_lo))/max(hi-lo,vec2f(0.000001)),vec2f(0),vec2f(1));
    let overlap=coverage.x*coverage.y;
    let raised=clamp(vec2f(y)-neighbor,vec2f(0),vec2f(1))*weight;
    let lower=clamp(neighbor-vec2f(y),vec2f(0),vec2f(1))*weight;
    let rim=dot(raised,coverage)-min(raised.x,raised.y)*overlap;
    let crease=dot(lower,coverage)-min(lower.x,lower.y)*overlap;
    let corner=raised.x*raised.y*overlap;
    let contact_corner=lower.x*lower.y*overlap;
    return vec2f(0.55*rim+0.25*corner,0.28*crease+0.10*contact_corner);
}
