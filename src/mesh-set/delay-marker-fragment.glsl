uniform float base;
uniform vec3 markerColor;
uniform float pulse;
varying float vIntensity;

void main() {
    vec3 color = mix( vec3( base ), markerColor, vIntensity );
    gl_FragColor = vec4( color * pulse, 1.0 );
}
