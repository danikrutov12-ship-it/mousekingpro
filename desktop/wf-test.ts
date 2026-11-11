import { buildWorkflow } from './src/main/workflows'
const g = buildWorkflow({ model: 'faceswap', prompt: '', upscale: true, detail: false, restore: true, restoreWeight: 0.45, faceIndex: 0, allFaces: false }, ['ref_1.jpg', 'ref_2.jpg'])
for (const [id, n] of Object.entries(g)) console.log(id, n.class_type, JSON.stringify(n.inputs).slice(0, 200))
