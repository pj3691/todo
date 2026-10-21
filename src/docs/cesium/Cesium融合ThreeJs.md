# Cesium融合ThreeJs

> Cesium提供了强大的地理数据展示能力，但是在开发的过程中，也逐渐感受到Cesium在几何自定义方面比较吃力，提供的Primitive API和Entity API只能定义指定的几种几何，同时Cesium提供的几何也不支持细分，导致在写shader的时候会因为细分不够导致某些采样数不够从而导致shader达不到想要的效果。想要自定义几何只能自己写方法来定义顶点和索引，想要进行CSG操作也要写额外的方法。而threejs在这方面是比较强大的，同时也有threeBsp这种库来提供几何之间的CSG操作。threejs的扩展库也比cesium多太多了，所以有必要开发一个插件，让cesium可以直接消费threejs的mesh。

## 融合思路

在上网查了资料和查看cesium源代码之后，找到了下面几种融合的方法

1. 直接在cesium原canvas上再叠一层threejs的canvas，将cesium相机和threejs相机同步，再将threejs的坐标系转到cesium的坐标系中。
2. 利用cesium的`DrawCommand` API，将threejs mesh的几何信息传给DrawCommand在cesium上绘制几何。同时读取mesh的材质信息，将mesh的材质参数通过uniform传给DrawCommand着色器，再在着色器中根据材质信息还原对应的材质。

## canvas叠加

这种方法比较简单，直接在Cesium canvas上叠加一个canvas，然后初始化threejs，并在cesium的相机更新时间里同步相机即可。相机同步方法如下

```ts
  /**
   * 同步Three.js相机到Cesium相机视角
   */
  syncThreeCamera() {
    const cesiumCamera = this.viewer.camera;
    const position = cesiumCamera.positionWC;
    const direction = cesiumCamera.directionWC;
    const up = cesiumCamera.upWC;

    // Cesium is Z-up, Three.js is Y-up, so convert coordinates
    const threePosition = new THREE.Vector3(position.x, position.z, -position.y);
    const threeDirection = new THREE.Vector3(direction.x, direction.z, -direction.y);
    const threeUp = new THREE.Vector3(up.x, up.z, -up.y);

    this.camera.position.copy(threePosition);
    this.camera.lookAt(threePosition.clone().add(threeDirection));
    this.camera.up.copy(threeUp);

    // 同步相机参数
    if (cesiumCamera.frustum instanceof Cesium.PerspectiveFrustum) {
      this.camera.fov = Cesium.Math.toDegrees(cesiumCamera.frustum.fov!);
    }
    this.camera.near = cesiumCamera.frustum.near;
    this.camera.far = cesiumCamera.frustum.far;
    this.camera.aspect = this.canvas.clientWidth / this.canvas.clientHeight;
    this.camera.updateProjectionMatrix();
    // console.log(this.camera);
  }
```

这种方法比较简单，但是还是有一些坑：

1. threejs和cesium的坐标系不太一样，threejs坐标系是y-up的，而cesium是z-up的，同步坐标的时候要注意。

2. 要将threejs的canvas的样式中的pointer-event设置为none，否则cesium的鼠标时间会不生效。

3. 因为这本质上是两个上下文，所以多个drawCall和遮挡问题是没办法解决的，要想处理这个问题只能用第二个方案从底层将其融合。

## DrawCommand方案

### 几何解析

要想复原一个mesh，首先要知道这个几何的顶点、索引、法线、切线，副切线、uv等信息，这些都可以通过`geometry`的`getAttribute`（索引是`getIndex`方法）来获取。如果要获取切线信息，则要通过`computeTangents`来获取。获取到顶点信息后还需要在顶点着色器中将坐标转为z-up，转换方法如下：

```glsl
// Three.js (Y-up) → Cesium (Z-up) 坐标系转换
// 等价于绕 X 轴旋转 -90°: x'=x, y'=-z, z'=y
const mat3 yUpToZUp = mat3(1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, -1.0, 0.0);
vec3 posLocal = yUpToZUp * position;
```

然后再将位置与cesium内置的mvp矩阵（`czm_modelView`，`czm_projection`）相乘就能得到屏幕空间坐标；顶点坐标还原完之后就要计算TBN矩阵用于后续fragment Shader中法线贴图的着色计算。法线、切线，副切线要用同样的方法修改坐标，再与`czm_normal`矩阵相乘从模型坐标切换到眼坐标系下并归一化。

### 材质解析

1. 贴图转换
   
   threejs材质的贴图信息存在THREE.MeshStandardMaterial.map中，类型为THREE.Texture，通过其image属性可以将贴图图片提取出来，cesium Texture API的source属性需要一个canvas，所以可以先新建一个canvas，然后用ctx2d.drawImage方法将image绘制到canvas上；同时还要建立cesium->threejs TextureWrap的映射来生成sampler，这样就可以通过source和sampler重建cesium的Texture。

2. 着色器公式计算
   pbr计算公式：
   $$
   L_o = L_i \cdot (f_{diff} + f_{spec}) \cdot (N \cdot L)
    $$

   - \(L_o\)：最终出射光
   - \(L_i\)：光源强度
   - \(N \cdot L\)：入射角余弦（光照强度衰减）
   - \(f_{diff}\)：漫反射
   - \(f_{spec}\)：镜面反射

 
    漫反射计算：
    $$
    f_{diff} = \frac{(1 - F)\cdot c_{diff}}{\pi}
    $$

   其中

   $$
   c_{diff} = baseColor \cdot (1 - metallic)
   $$
   - \(c_{diff}\)：漫反射颜色
  
   镜面反射计算：
   $$
    f_{spec} = F \cdot D \cdot G
   $$

   - \(F\)：菲涅尔系数
   - \(D\)：法线分布
   - \(G\)：几何遮挡

   菲涅尔（F）计算：
   $$
    F = F_0 + (F_{90} - F_0)(1 - V \cdot H)^5
   $$

   其中

   $$
   F_0 = (1 - metallic)\cdot 0.04 + metallic \cdot baseColor
   $$

   $$
   F_{90} = \text{clamp}(25 \cdot \max(F_0), 0, 1)
   $$

   - \(F_0\)：基础反射率
   - \(F_{90}\)：掠射反射率
   - \(G\)：几何遮挡

   法线分布（D）计算：
   $$
   D = \frac{\alpha^2}{\pi \left[(N \cdot H)^2(\alpha^2 - 1) + 1\right]^2}
   $$

   几何遮挡（G）计算：

   $$
   G = G_1(N \cdot V) \cdot G_1(N \cdot L)
   $$

   其中：

   $$
   G_1(x) = \frac{x}{x(1 - k) + k}
   $$

   $$
   k = \frac{\alpha^2}{2}
   $$
   
3. 着色器公式计算

