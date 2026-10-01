import {Mesh, Sprite, Texture, type Object3D, type Material, type BufferGeometry} from 'three';
/** Dispose owned mesh resources, preserving shared materials and their textures. */
export function disposeObject(root:Object3D, shared:ReadonlySet<Material>, sharedTextures:ReadonlySet<Texture>=new Set()){
 const geometries=new Set<BufferGeometry>(),materials=new Set<Material>();
 root.traverse(object=>{if(object instanceof Mesh||object instanceof Sprite){geometries.add(object.geometry);for(const mat of Array.isArray(object.material)?object.material:[object.material])if(!shared.has(mat))materials.add(mat);}});
 const textures=new Set<Texture>();
 for(const mat of materials)for(const value of Object.values(mat))if(value instanceof Texture&&!sharedTextures.has(value))textures.add(value);
 textures.forEach(texture=>texture.dispose());
 geometries.forEach(geometry=>geometry.dispose());materials.forEach(mat=>mat.dispose());
}
