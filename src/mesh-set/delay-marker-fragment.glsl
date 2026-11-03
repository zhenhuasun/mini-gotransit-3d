uniform float base;
uniform vec3 markerColor;
varying float vIntensity;

void main() {
    vec3 color = mix( vec3( base ), markerColor, vIntensity );
    gl_FragColor = vec4( color, 1.0 );
}
