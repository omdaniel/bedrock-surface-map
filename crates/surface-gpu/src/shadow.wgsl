struct Params { camera: vec4f, screen: vec4f, bounds: vec4f, lighting:vec4f }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> heights: array<f32>;
@group(0) @binding(2) var<storage, read_write> shadows: array<f32>;

// Independent NW-to-SE diagonals: prefix maximum decays with sun-ray slope.
@compute @workgroup_size(64)
fn shadow(@builtin(global_invocation_id) gid: vec3u) {
    let w = u32(p.bounds.z); let h = u32(p.bounds.w); let d = gid.x;
    if d >= w + h - 1u { return; }
    var x = d; var z = 0u;
    if d >= w { x = 0u; z = d - w + 1u; }
    var horizon = -1000000.0;
    loop {
        if x >= w || z >= h { break; }
        let i = z*w+x; let y = heights[i]; horizon = max(-1000000.0,horizon-p.screen.w);
        if y > -900000.0 { horizon = max(horizon,y); }
        shadows[i] = horizon;
        x += 1u; z += 1u;
    }
}
