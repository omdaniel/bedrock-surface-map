import DefaultTheme from 'vitepress/theme';
import Welcome from './Welcome.vue';
import './style.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) { app.component('Welcome', Welcome); },
};
