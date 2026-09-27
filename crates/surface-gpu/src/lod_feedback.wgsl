// Striped writes keep unknown-coverage diagnostics from serializing the image.
// Reduction preserves the union of flags and every evaluated sample count.
@group(0) @binding(0) var<storage,read> lanes:array<vec4u,128>;
@group(0) @binding(1) var<storage,read_write> result:vec4u;
@compute @workgroup_size(1)
fn reduce() {
    var sum=vec4u(0);
    for(var i=0u;i<128u;i++) {
        sum.x|=lanes[i].x;
        sum.y+=lanes[i].y;
        sum.z+=lanes[i].z;
        sum.w+=lanes[i].w;
    }
    result=sum;
}
