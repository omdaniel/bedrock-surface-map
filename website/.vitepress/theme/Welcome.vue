<script setup>
import { withBase } from 'vitepress';
const demo = 'https://omdaniel.github.io/bedrock-surface-map/demo/';
</script>

<template>
  <div class="welcome">
    <section class="hero" aria-labelledby="welcome-title">
      <div class="hero-copy">
        <p class="eyebrow">YOUR WORLD, AT A GLANCE</p>
        <h1 id="welcome-title">A little perspective.<br><em>A whole world to explore.</em></h1>
        <p class="intro">An interactive overhead map for Minecraft Bedrock. Find your friends, read the landscape, and watch your world take shape.</p>
        <div class="actions">
          <a class="button primary" :href="demo" target="_blank" rel="noopener">Explore the demo <span aria-hidden="true">↗</span></a>
          <a class="button secondary" :href="withBase('/start.html')">Map your world <span aria-hidden="true">→</span></a>
        </div>
        <p class="hero-note">Free to self-host. Open source. No login to try the demo.<br>Interactive maps require a WebGPU-capable browser.</p>
      </div>
      <figure class="hero-map">
        <a :href="demo" target="_blank" rel="noopener" aria-label="Open the interactive map demo"><img :src="withBase('/docs/media/demo.png')" alt="Textured coastal islands with sunlit terraces, water and fictional player markers" width="1440" height="1000" fetchpriority="high"></a>
        <figcaption><span class="caption-dot" aria-hidden="true"></span> THE PUBLIC DEMO <span>Fictional players · simulated edits</span></figcaption>
      </figure>
    </section>

    <section class="field-notes" aria-label="What the map does">
      <article><span class="number">01 / EXPLORE</span><h2>From coastlines to blocks.</h2><p>Pan and zoom through textured terrain. Adjust the sunlight to see the shape of a hillside, or inspect the blocks beneath your pointer.</p></article>
      <article><span class="number">02 / FIND</span><h2>Put friends on the map.</h2><p>Choose a gamertag to center on a player. Follow their journey, with directional markers and separate freshness indicators.</p></article>
      <article><span class="number">03 / KEEP UP</span><h2>See the world change.</h2><p>With live integration, surface edits and newly explored terrain appear without reloading. Your view and lighting stay where you left them.</p></article>
    </section>

    <section class="paths" aria-labelledby="paths-title">
      <div class="section-heading"><p class="eyebrow">MAKE YOURSELF AT HOME</p><h2 id="paths-title">Where would you like to start?</h2><p>You can explore a snapshot without a server, add a live map to an existing world, or help build the project.</p></div>
      <div class="path-list">
        <a :href="withBase('/docs/INSTALL.html')"><span class="path-index">A</span><span><strong>I have a world export</strong><small>Download the Linux viewer and import an offline .mcworld or ZIP.</small></span><span aria-hidden="true">↗</span></a>
        <a :href="withBase('/docs/OPERATOR-INSTALL.html')"><span class="path-index">B</span><span><strong>I run a Bedrock server</strong><small>Use the live bundle with Docker, or follow the Crafty and AMP guides.</small></span><span aria-hidden="true">↗</span></a>
        <a :href="withBase('/CONTRIBUTING.html')"><span class="path-index">C</span><span><strong>I want to contribute</strong><small>Pick a component, set up its tools, and test with synthetic worlds.</small></span><span aria-hidden="true">↗</span></a>
      </div>
    </section>

    <section class="underneath" aria-labelledby="underneath-title">
      <div><p class="eyebrow">A DIFFERENT WAY TO DRAW A MAP</p><h2 id="underneath-title">Surface data in.<br>Perspective out.</h2></div>
      <div><p>The browser receives compact surface data and draws the map locally with WebGPU. Textures, shadows and zoomed-out views are rendered on your device, instead of arriving as pre-rendered image tiles.</p><p>The optional live packs work with Mojang’s official Bedrock Dedicated Server. Player positions and terrain updates are independent: use the features your world needs.</p><a class="text-link" :href="withBase('/docs/DEVELOPMENT.html')">Explore the architecture →</a></div>
    </section>

    <aside class="boundaries"><strong>Know the boundaries.</strong> This is an Overworld surface map, not a view of underground interiors or a world backup. Live integration requires server administration and experimental Bedrock networking APIs. Very wide views can require zooming in. <a :href="withBase('/docs/COMPATIBILITY.html')">Check compatibility →</a></aside>
  </div>
</template>
