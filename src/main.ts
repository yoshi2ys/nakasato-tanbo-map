import './style.css';
import { createMap } from './map';

const container = document.getElementById('map');
if (!container) {
  throw new Error('#map が見つかりません');
}

createMap(container);
