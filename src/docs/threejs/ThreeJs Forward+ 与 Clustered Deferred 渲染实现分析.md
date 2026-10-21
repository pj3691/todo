# Forward+ 与 Clustered Deferred 渲染实现分析

## 0. 文档范围与结论

本文基于当前仓库源码，对项目中的 `Forward+` 与 `Clustered Deferred` 两套渲染路径进行逐层拆解。分析重点覆盖：

- 渲染器类结构与继承关系
- 聚类光照的 CPU/GPU 协作机制
- Forward+ 的单通道光照路径
- Clustered Deferred 的 G-Buffer + 全屏光照路径
- `TextureBuffer` 在 WebGL 1 中承担“结构化缓冲区替代品”的角色
- README 中性能曲线背后的实现原因

核心结论可以先概括为三点：

1. 这个项目的“高级渲染”核心不在于不同 BRDF，而在于“共享的聚类光照索引 + 不同的着色时机”。
2. `Forward+` 和 `Clustered Deferred` 都复用了 `BaseRenderer.updateClusters()` 的聚类结果，差别只在于光照发生在几何绘制阶段还是全屏光照阶段。
3. `Clustered Deferred` 在大量光源下更快，主要因为它把“几何处理”和“光照累加”拆开，并且通过 2 个优化后的 G-Buffer 显著降低了 MRT 读写带宽。

需要先澄清一点：项目中的光源是**带半径的点光源**，并不是 spotlight 锥光。源码里每个 light 只有 `position / color / radius` 三个属性，见 `src/scene.js:18-31`。

---

## 1. 项目总体架构

### 1.1 模块分工

项目的渲染系统可以拆成五层：

1. `src/init.js`
   负责 WebGL 上下文、扩展、GUI、相机、控制器、统计器、主循环包装器初始化。
2. `src/main.js`
   负责选择渲染器、创建场景、装配 GUI、定义每帧调用顺序。
3. `src/scene.js`
   负责加载 glTF、维护动态点光源数组、执行模型绘制。
4. `src/renderers/*.js`
   负责不同渲染路径的 CPU 端组织、纹理缓冲更新、FBO 绑定、shader uniform 绑定。
5. `src/shaders/*.glsl*`
   负责几何阶段写入、聚类索引定位、逐光源着色、全屏 deferred 光照。

### 1.2 类结构与继承关系

当前渲染器层次如下：

```text
BaseRenderer
├─ ForwardPlusRenderer
└─ ClusteredDeferredRenderer

ForwardRenderer
└─ 不继承 BaseRenderer，只作为传统逐像素 forward 基线实现
```

对应源码位置：

- `BaseRenderer`：`src/renderers/base.js:6-86`
- `ForwardPlusRenderer`：`src/renderers/forwardPlus.js:10-92`
- `ClusteredDeferredRenderer`：`src/renderers/clusteredDeferred.js:15-191`
- 基线 `ForwardRenderer`：`src/renderers/forward.js:8-68`

### 1.3 运行时调用链

从程序启动到每帧渲染的调用关系如下：

```text
index.html
  -> build/bundle.js
    -> src/init.js
       -> 创建 canvas / gl / 扩展 / GUI / camera / controls / stats
       -> require('./main')
          -> src/main.js
             -> setRenderer(...)
             -> new Scene()
             -> scene.loadGLTF(...)
             -> makeRenderLoop(render)()

每帧 tick:
cameraControls.update()
-> stats.begin()
-> render()
   -> scene.update()
   -> params._renderer.render(camera, scene)
   -> wireframe.render(camera)
-> stats.end()
-> requestAnimationFrame(tick)
```

代码对应关系：

- `makeRenderLoop()`：`src/init.js:88-99`
- 主入口和 GUI 切换：`src/main.js:8-34`
- 每帧执行顺序：`src/main.js:55-68`

### 1.4 渲染器如何与场景、相机、着色器程序交互

这一层的接口设计非常直接：

- **相机**来自 Three.js 的 `PerspectiveCamera`，在每帧开始时由渲染器读取其 `matrixWorld` 和 `projectionMatrix`，计算视图矩阵和 VP 矩阵，见 `src/renderers/forwardPlus.js:34-39`、`src/renderers/clusteredDeferred.js:113-117`。
- **场景**由 `Scene` 维护：
  - `scene.lights` 提供 CPU 端光源数组，供渲染器写入 `TextureBuffer`；
  - `scene.draw(shaderProgram)` 负责把模型纹理和顶点属性绑定到当前 shader program，见 `src/scene.js:167-196`。
- **着色器程序**通过 `loadShaderProgram()` 编译、链接、并把 uniform / attrib location 挂到 JS 对象上，见 `src/utils.js:58-64`。

因此，渲染器本质上只做三件事：

1. 更新 camera 相关矩阵。
2. 更新 light/cluster/G-buffer 等 GPU 资源。
3. 调 `scene.draw()` 或 `renderFullscreenQuad()` 启动真正绘制。

---

## 2. BaseRenderer：聚类光照的公共骨架

### 2.1 BaseRenderer 的职责

`BaseRenderer` 只做一件关键事情：维护 cluster texture，并在每帧把“每个 cluster 受哪些灯影响”写入 GPU 可读纹理。

构造函数见 `src/renderers/base.js:7-13`：

```js
this._clusterTexture = new TextureBuffer(
  xSlices * ySlices * zSlices,
  MAX_LIGHTS_PER_CLUSTER + 1
);
```

这里的设计含义是：

- `elementCount = xSlices * ySlices * zSlices`
  - 每个元素对应一个 cluster。
- `elementSize = MAX_LIGHTS_PER_CLUSTER + 1`
  - 第 0 个 float 存“该 cluster 中真实光源数”
  - 后面依次存 light index 列表

`ForwardPlusRenderer` 和 `ClusteredDeferredRenderer` 都继承它，因此两条高级渲染路径复用完全相同的聚类结果。

### 2.2 线性切片方式

这个项目的 cluster 是一个三维规则网格：

- `xSlices`：屏幕宽度方向切片数
- `ySlices`：屏幕高度方向切片数
- `zSlices`：相机近平面到远平面的线性深度切片数

默认值来自 `src/main.js:11, 25-29`，即：

```js
const NUM_SLICES = 15;
new ForwardPlusRenderer(15, 15, 15);
new ClusteredDeferredRenderer(15, 15, 15);
```

所以默认 cluster 总数是：

```text
15 * 15 * 15 = 3375
```

### 2.3 updateClusters() 的完整算法

`updateClusters(camera, viewMatrix, scene)` 位于 `src/renderers/base.js:15-85`，每帧流程如下。

#### 第一步：清零每个 cluster 的 light count

`src/renderers/base.js:18-25`

三重循环遍历所有 cluster，把第 0 个槽位设为 0。这里没有清空整段 light index 列表，因为只要 count 被重置，旧索引在 shader 中不会被读取。

#### 第二步：把光源从世界空间变换到相机视空间

`src/renderers/base.js:32-38`

```js
vec4.transformMat4(lightPos, lightPos, viewMatrix);
lightPos[2] *= -1.0;
```

这里有两个关键信息：

- 原始 `scene.lights[i].position` 是世界空间位置。
- 经过 view matrix 变换后，代码把 `z` 取反，是因为相机朝向按 OpenGL/WebGL 习惯沿 `-Z` 方向看；这样后续计算 `depth` 时，前方物体会变成正深度值。

#### 第三步：计算光源影响的 z slice 范围

`src/renderers/base.js:40-46`

```js
const clusterLengthInZ = (camera.far - camera.near) / this._zSlices;
let maxZ = floor((depth - near + radius) / clusterLengthInZ);
let minZ = floor((depth - near - radius) / clusterLengthInZ);
```

本质上把球形光源沿 z 方向投影成一个区间 `[depth - radius, depth + radius]`，再映射到线性 z slice。

#### 第四步：计算光源影响的 x / y slice 范围

`src/renderers/base.js:48-62`

代码先根据当前深度 `depth` 计算该深度处视锥体的半宽和半高：

```js
const halfFovY = tan(fov / 2)
const halfFovX = aspect * halfFovY
const halfWidth = halfFovX * depth
const halfHeight = halfFovY * depth
```

然后把光源球体在该深度切片上的 x/y 范围近似为：

```text
[lightPos.x - radius, lightPos.x + radius]
[lightPos.y - radius, lightPos.y + radius]
```

再映射为 slice 区间。

这说明此实现采用的是**基于光源中心深度的近似包围盒分桶**，而不是严格的球-视锥 cluster 相交测试。优点是实现简单、CPU 成本低；代价是会产生一定 false positive，极端情况下也可能对大半径光源给出较粗的覆盖范围。

#### 第五步：把 light index 写入所有受影响 cluster

`src/renderers/base.js:64-80`

三重循环遍历 `[minX, maxX] * [minY, maxY] * [minZ, maxZ]` 内所有 cluster：

```js
let numLightsInCurCluster = count + 1;
if (numLightsInCurCluster > MAX_LIGHTS_PER_CLUSTER) continue;

this._clusterTexture.buffer[bufferIndex(i, 0)] = numLightsInCurCluster;
this._clusterTexture.buffer[bufferIndex(i, componentIdx) + elementIdxInComponent] = lightIdx;
```

关键点：

- 第 0 个 float 存 count。
- 第 1 个开始存 light index。
- 超过 `MAX_LIGHTS_PER_CLUSTER` 的多余光源被直接丢弃，不会写入。

### 2.4 Cluster 索引公式

CPU 端与 GPU 端都使用同一个一维线性索引：

```text
clusterIdx = x + y * xSlices + z * xSlices * ySlices
```

CPU 端见 `src/renderers/base.js:21, 68`；GPU 端见：

- `src/shaders/forwardPlus.frag.glsl.js:94-101`
- `src/shaders/deferred.frag.glsl.js:111-118`

这保证了“CPU 写入哪个 cluster，GPU 就按同样公式读取哪个 cluster”。

---

## 3. TextureBuffer：WebGL 1 中的“结构化缓冲区替身”

### 3.1 为什么需要 TextureBuffer

WebGL 1 没有 SSBO，也没有现代 OpenGL 那种可任意绑定的大型结构化 buffer。这个项目因此采用 `RGBA32F` 纹理来模拟“可随机索引的数据表”，实现代码在 `src/renderers/textureBuffer.js:3-52`。

### 3.2 数据布局

`TextureBuffer` 的构造逻辑：

```js
this._pixelsPerElement = Math.ceil(elementSize / 4);
gl.texImage2D(..., elementCount, this._pixelsPerElement, ..., gl.RGBA, gl.FLOAT, null);
this._buffer = new Float32Array(elementCount * 4 * this._pixelsPerElement);
```

也就是说：

- 纹理宽度 = `elementCount`
- 纹理高度 = `ceil(elementSize / 4)`
- 每个 texel 存 4 个 float
- 一个“逻辑元素”沿纹理纵向占若干行

`bufferIndex(index, component)` 的公式见 `src/renderers/textureBuffer.js:41-42`：

```text
bufferOffset = 4 * index + 4 * component * elementCount
```

这意味着：

- `index` 决定纹理的 x 坐标
- `component / 4` 决定纹理的 y 坐标

### 3.3 light texture 的具体结构

在 `ForwardRenderer`、`ForwardPlusRenderer`、`ClusteredDeferredRenderer` 中，光源纹理都通过：

```js
new TextureBuffer(NUM_LIGHTS, 8)
```

创建，见：

- `src/renderers/forward.js:10`
- `src/renderers/forwardPlus.js:15`
- `src/renderers/clusteredDeferred.js:22`

每个 light 8 个 float，布局为：

| 逻辑元素 | 内容 |
| --- | --- |
| 第 0 个 RGBA texel | `position.x, position.y, position.z, radius` |
| 第 1 个 RGBA texel | `color.r, color.g, color.b, unused` |

CPU 写入代码见：

- `src/renderers/forwardPlus.js:45-56`
- `src/renderers/clusteredDeferred.js:138-149`

若 `NUM_LIGHTS = 300`，则 light texture 尺寸是：

```text
300 x 2, 格式 RGBA32F
```

### 3.4 cluster texture 的具体结构

cluster texture 的构造位于 `src/renderers/base.js:8-12`：

```js
new TextureBuffer(xSlices * ySlices * zSlices, MAX_LIGHTS_PER_CLUSTER + 1)
```

逻辑布局为：

| 槽位 | 内容 |
| --- | --- |
| component 0 | `count` |
| component 1..N | `lightIdx[0..N-1]` |

若默认参数为：

- `xSlices = ySlices = zSlices = 15`
- `MAX_LIGHTS_PER_CLUSTER = 300`

则 cluster texture 尺寸为：

```text
width  = 15 * 15 * 15 = 3375
height = ceil((300 + 1) / 4) = 76
format = RGBA32F
```

这也是 shader 中 `clusterTextureWidth/Height` 的来源，见：

- `src/shaders/forwardPlus.frag.glsl.js:99-101`
- `src/shaders/deferred.frag.glsl.js:116-118`

### 3.5 GPU 读取方式

两个 shader 都通过 `ExtractFloat()` 从任意纹理槽位提取单个 float，函数见：

- `src/shaders/forwardPlus.frag.glsl.js:38-53`
- `src/shaders/deferred.frag.glsl.js:27-42`

读取步骤本质上是：

1. 根据 `index` 算 x 坐标。
2. 根据 `component / 4` 算 y 坐标。
3. `texture2D()` 取出 `vec4`。
4. 再从 `vec4[0..3]` 中选目标分量。

这就是整个项目 CPU/GPU 数据交换的基础设施。

---

## 4. Forward+ 渲染实现细节

### 4.1 ForwardPlusRenderer 的核心结构

`ForwardPlusRenderer` 定义在 `src/renderers/forwardPlus.js:10-92`，成员可以分成三类：

1. **继承自 BaseRenderer 的 cluster 资源**
   - `_clusterTexture`
   - `_xSlices / _ySlices / _zSlices`
2. **Forward+ 自己的 light 资源**
   - `_lightTexture`
3. **每帧矩阵与 shader program**
   - `_shaderProgram`
   - `_projectionMatrix / _viewMatrix / _viewProjectionMatrix`

构造函数完成两件事：

- 调 `super(xSlices, ySlices, zSlices)` 建 cluster texture。
- 编译 `forwardPlus.vert.glsl + forwardPlus.frag.glsl.js`，把聚类参数直接编译进 shader，见 `src/renderers/forwardPlus.js:17-27`。

### 4.2 Forward+ 的 CPU 端每帧流程

`render(camera, scene)` 的步骤见 `src/renderers/forwardPlus.js:34-91`：

1. 更新 view / projection / VP 矩阵。
2. 调 `updateClusters()` 生成 cluster -> light list。
3. 遍历 `scene.lights`，把光源数据写入 `_lightTexture`。
4. 绑定默认 framebuffer，也就是直接渲染到屏幕。
5. 绑定 `u_lightbuffer` 和 `u_clusterbuffer`。
6. 传入 `u_near/u_far/u_width/u_height/u_viewMat`。
7. 调 `scene.draw(this._shaderProgram)` 绘制整个场景。

这说明 Forward+ 仍然是**单通道、逐物体绘制**：

- 顶点处理、纹理采样、法线贴图、光照累加都在一次 draw call 的片段着色阶段内完成。
- 它只是把“遍历所有光源”优化成了“只遍历当前 cluster 的光源”。

### 4.3 片段如何确定自己属于哪个 cluster

Forward+ 片段着色器位于 `src/shaders/forwardPlus.frag.glsl.js:82-121`。

核心索引代码是：

```glsl
vec4 viewPos = u_viewMat * vec4(v_position.x, v_position.y, v_position.z, 1.0);

int z = int((-viewPos.z - u_near) / ((u_far - u_near) / float(zSlices)));
int x = int(gl_FragCoord.x / (u_width / float(xSlices)));
int y = int(gl_FragCoord.y / (u_height / float(ySlices)));
int clusterIdx = x + y * xSlices + z * xSlices * ySlices;
```

对应逻辑：

- `x`：使用 `gl_FragCoord.x`，按屏幕宽度等分。
- `y`：使用 `gl_FragCoord.y`，按屏幕高度等分。
- `z`：先把片段位置从世界空间变到视空间，再按线性深度分段。

要注意两个实现前提：

1. 顶点 shader 里 `v_position = a_position`，并没有单独 model matrix，见 `src/shaders/forwardPlus.vert.glsl:14-18`。
2. 这在当前项目中成立，是因为加载的 Sponza 顶点位置直接被当作世界空间坐标使用，`scene.draw()` 也没有模型变换，见 `src/scene.js:138-150, 182-195`。

### 4.4 Forward+ 中 light clustering 的工作原理

Forward+ 的本质是：

- CPU 把空间切成固定 3D cluster。
- CPU 对每个 light 计算其可能影响哪些 cluster。
- GPU 在片段阶段先定位自身 cluster，再只遍历该 cluster 对应的 light list。

和传统 forward 相比，差异可以直接从 shader 看出来：

- 传统 forward：`for (int i = 0; i < NUM_LIGHTS; ++i)`，见 `src/shaders/forward.frag.glsl.js:79-88`
- Forward+：先读 `realNumLights`，再只遍历该 cluster 的 lights，见 `src/shaders/forwardPlus.frag.glsl.js:99-116`

因此复杂度从近似：

```text
O(屏幕可见片段数 * 总光源数)
```

下降为：

```text
O(屏幕可见片段数 * 当前 cluster 平均光源数)
```

### 4.5 光照数据如何通过纹理缓冲传给 GPU

Forward+ 在 JS 端把 light data 写入 `_lightTexture`，然后绑定到 `TEXTURE2`：

```js
gl.activeTexture(gl.TEXTURE2);
gl.bindTexture(gl.TEXTURE_2D, this._lightTexture.glTexture);
gl.uniform1i(this._shaderProgram.u_lightbuffer, 2);
```

见 `src/renderers/forwardPlus.js:73-76`。

cluster data 同理绑定到 `TEXTURE3`，见 `src/renderers/forwardPlus.js:78-81`。

shader 中读取顺序是：

1. `ExtractFloat(u_clusterbuffer, ..., clusterIdx, 0)` 读 count。
2. `ExtractFloat(..., clusterIdx, i + 1)` 读第 `i` 个 light index。
3. `UnpackLight(lightIdx)` 再去 `u_lightbuffer` 里读该光源的位置、半径、颜色。

对应位置：

- cluster count：`src/shaders/forwardPlus.frag.glsl.js:99-101`
- cluster light index：`src/shaders/forwardPlus.frag.glsl.js:103-108`
- light unpack：`src/shaders/forwardPlus.frag.glsl.js:55-69`

### 4.6 Forward+ 的最终着色

Forward+ 片段 shader 做的是 Lambert 漫反射加环境光：

```glsl
float lightIntensity = cubicGaussian(2.0 * lightDistance / light.radius);
float lambertTerm = max(dot(L, normal), 0.0);
fragColor += albedo * lambertTerm * light.color * vec3(lightIntensity);
fragColor += albedo * ambientLight;
```

见 `src/shaders/forwardPlus.frag.glsl.js:112-121`。

光照衰减函数 `cubicGaussian()` 见 `src/shaders/forwardPlus.frag.glsl.js:71-80`，作用是让光照在 `radius` 边界处平滑衰减到 0。

---

## 5. Clustered Deferred 渲染实现细节

### 5.1 ClusteredDeferredRenderer 的核心结构

`ClusteredDeferredRenderer` 位于 `src/renderers/clusteredDeferred.js:15-191`，它在 `BaseRenderer` 的基础上多了三组关键资源：

1. **MRT FBO 资源**
   - `_fbo`
   - `_depthTex`
   - `_gbuffers[]`
2. **两个 shader program**
   - `_progCopy`：几何阶段，把材质数据写进 G-Buffer
   - `_progShade`：全屏阶段，从 G-Buffer 读出数据并做 clustered lighting
3. **light texture**
   - `_lightTexture`

### 5.2 G-Buffer 的创建过程

`setupDrawBuffers(width, height)` 在 `src/renderers/clusteredDeferred.js:48-93`。

#### 深度附件

创建了一个深度纹理：

```js
gl.texImage2D(
  gl.TEXTURE_2D, 0,
  gl.DEPTH_COMPONENT,
  width, height, 0,
  gl.DEPTH_COMPONENT,
  gl.UNSIGNED_SHORT, null
);
```

见 `src/renderers/clusteredDeferred.js:55-65`。

作用：

- 用于几何阶段的深度测试，保证 G-Buffer 只存可见表面。
- 当前实现中光照阶段**没有直接读取深度纹理**，因为位置已经被打包进 G-Buffer。

#### 颜色附件

G-Buffer 全部采用 `RGBA + FLOAT`，见 `src/renderers/clusteredDeferred.js:67-82`：

```js
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.FLOAT, null);
```

并通过 `WEBGL_draw_buffers.drawBuffersWEBGL(attachments)` 开启 MRT，见 `src/renderers/clusteredDeferred.js:88-90`。

这里依赖的 WebGL 扩展在 `src/init.js:28-50` 中统一检查和启用，包括：

- `OES_texture_float`
- `WEBGL_depth_texture`
- `WEBGL_draw_buffers`

### 5.3 优化后的 G-Buffer 格式

源码中 `OPTIMIZED = true`，因此：

```js
export const NUM_GBUFFERS = OPTIMIZED ? 2 : 3;
```

见 `src/renderers/clusteredDeferred.js:12-13`。

几何阶段片段着色器 `src/shaders/deferredToTexture.frag.glsl:24-44` 的优化后写法是：

```glsl
gl_FragData[0] = vec4(col.x, col.y, col.z, v_position.z);
vec2 compressedNorm = compressNormal(norm);
gl_FragData[1] = vec4(compressedNorm.x, compressedNorm.y, v_position.x, v_position.y);
```

因此 2 个 G-Buffer 的语义为：

| G-Buffer | 存储内容 |
| --- | --- |
| `gb0` | `albedo.rgb + position.z` |
| `gb1` | `compressedNormal.xy + position.x + position.y` |

对比未优化版本，原本需要 3 个缓冲：

- `albedo`
- `normal.xyz`
- `position.xyz`

现在通过“法线压缩 + position 分散打包”压缩成了 2 个。

### 5.4 法线压缩技术：2D normal encoding

压缩函数见 `src/shaders/deferredToTexture.frag.glsl:19-22`：

```glsl
vec2 compressNormal(vec3 normal) {
    return vec2(normal.x / (normal.z + 1.0), normal.y / (normal.z + 1.0));
}
```

解压函数见 `src/shaders/deferred.frag.glsl.js:71-76`：

```glsl
float temp = 2.0 / (1.0 + x*x + y*y);
vec3 normal = vec3(x * temp, y * temp, temp - 1.0);
```

这是一种典型的球面到平面映射编码，优点是：

- 3 个法线分量压缩成 2 个 float
- 少一个 G-Buffer 分量写入
- 减少后续光照阶段从显存读回的数据量

直接收益就是：

1. 几何阶段更少的 MRT 写带宽
2. 光照阶段更少的纹理读取
3. 更低的显存占用和缓存压力

在这个项目里，它的系统级收益更大，因为少掉的不是“一个 float”，而是整个未优化版中单独的 normal/position 目标缓冲组合。

### 5.5 延迟着色管线的两阶段流程

#### 阶段 A：几何缓冲写入

`ClusteredDeferredRenderer.render()` 的前半段见 `src/renderers/clusteredDeferred.js:119-135`。

步骤：

1. `gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);`
2. 清空颜色和深度。
3. 使用 `_progCopy`。
4. 上传 VP 矩阵。
5. 调 `scene.draw(this._progCopy)`。

这个阶段不做任何逐光源计算，只把每个可见像素的：

- albedo
- normal（压缩后）
- world position

写进 G-Buffer。

#### 阶段 B：光照计算

后半段见 `src/renderers/clusteredDeferred.js:137-190`。

步骤：

1. 更新 `_lightTexture`。
2. 调 `updateClusters()` 更新 cluster texture。
3. 切回默认 framebuffer。
4. 绑定 `_progShade`。
5. 绑定 light texture / cluster texture / g-buffers。
6. 调 `renderFullscreenQuad(this._progShade)`。

这里的核心思想是：

- 几何 pass 只负责存材质与几何信息。
- 光照 pass 对屏幕上每个最终像素只执行一次。

### 5.6 deferred.frag.glsl.js 如何从 G-Buffer 读取数据

读取逻辑位于 `src/shaders/deferred.frag.glsl.js:84-95`：

```glsl
vec4 gb0 = texture2D(u_gbuffers[0], v_uv);
albedo = gb0.xyz;

vec4 gb1 = texture2D(u_gbuffers[1], v_uv);
vec2 compressedNorm = gb1.xy;
normal = decompressNormal(compressedNorm);
position = vec3(gb1.z, gb1.w, gb0.w);
```

即：

- `albedo = gb0.rgb`
- `position.z = gb0.a`
- `compressedNormal = gb1.xy`
- `position.x / position.y = gb1.zw`

恢复出世界空间位置和法线后，shader 与 Forward+ 一样继续：

1. 把 position 变到 view space 计算 z slice
2. 用 `gl_FragCoord.xy` 算 x/y slice
3. 定位 cluster
4. 遍历该 cluster 的 lights

对应聚类读取代码在 `src/shaders/deferred.frag.glsl.js:106-136`。

### 5.7 Clustered Deferred 的最终光照模型

Deferred 光照部分与 Forward+ 类似，但多了一个 Blinn-Phong 高光：

```glsl
vec3 L = normalize(light.position - position);
vec3 V = normalize(u_eye - light.position);
vec3 H = normalize(V + L);

float lambertTerm = max(dot(L, normal), 0.0);
float specularIntensity = pow(max(dot(H, normal), 0.0), exp);

fragColor += (albedo * lambertTerm + specularIntensity)
           * light.color
           * vec3(lightIntensity);
```

见 `src/shaders/deferred.frag.glsl.js:124-139`。

这里的实现重点不是高光公式本身，而是它发生在**全屏 quad** 上，而不是模型绘制时。

### 5.8 全屏光照阶段如何被触发

全屏 quad 顶点 shader 位于 `src/shaders/quad.vert.glsl:4-10`：

```glsl
gl_Position = vec4(a_position, 1.0);
v_uv = a_position.xy * 0.5 + 0.5;
```

`renderFullscreenQuad()` 则在 `src/utils.js:77-100` 中把一个覆盖 NDC `[-1, 1]` 的四边形送进 GPU。

因此光照 pass 的执行语义是：

```text
每个屏幕像素执行一次 deferred.frag.glsl.js
```

这也是它和 Forward+ 最大的结构差异。

---

## 6. 关键技术特性与参数影响

### 6.1 `xSlices / ySlices / zSlices` 对性能的影响

这三个参数直接影响三个维度：

1. **cluster 总数**
   - 总数 = `xSlices * ySlices * zSlices`
   - 越大，cluster texture 越大，CPU 清零成本和写入成本越高
2. **平均每个 cluster 的灯数**
   - 切得越细，单个 cluster 容纳的灯越少，shader 中光照循环越短
3. **定位与缓存成本**
   - cluster 太细时，虽然每个 cluster 灯变少，但 cluster texture 更大，查找和缓存局部性会变差

README 的实验结论是 15 到 20 个切片附近最好，见 `README.md:36-42`。这与源码默认值 `NUM_SLICES = 15`（`src/main.js:11`）是一致的。

从实现角度看，这个结论完全合理：

- 切片太少：cluster 很大，`realNumLights` 上升，Forward+/Deferred 里 per-fragment light loop 变长
- 切片太多：`updateClusters()` 的 CPU 三重分桶范围更碎，cluster texture 更大，shader 访问也更离散

还要注意，这里 z slice 是**线性分布**，不是 logarithmic depth slicing。在线性 z 分片下，近处 cluster 在屏幕空间往往仍偏大，导致近相机区域的光源分辨率不如现代 clustered shading 常见的对数深度方案。

### 6.2 `MAX_LIGHTS_PER_CLUSTER` 的作用机制

常量定义在 `src/renderers/base.js:4`：

```js
export const MAX_LIGHTS_PER_CLUSTER = 300;
```

它的作用是三重的：

1. **固定 cluster texture 尺寸**
   - `elementSize = MAX_LIGHTS_PER_CLUSTER + 1`
2. **限制最坏情况下 shader 循环的数据规模**
   - 虽然 shader 外层仍写成 `for (i = 0; i < NUM_LIGHTS; ++i)`，但实际会在 `i >= realNumLights` 时提早跳出
3. **作为溢出保护**
   - 一旦某个 cluster 超过该上限，后续灯会被直接忽略，见 `src/renderers/base.js:69-72`

这意味着它不是“理论约束”，而是**真实可见效果与性能之间的硬上限**：

- 值太小：高密度区域可能丢灯
- 值太大：cluster texture 变高，带宽和显存压力上升

### 6.3 TextureBuffer 类的角色

`TextureBuffer` 的角色可以总结为三句话：

1. 用浮点纹理模拟结构化数组。
2. 让 CPU 能按逻辑元素写入任意 layout。
3. 让 shader 通过 `index + component` 随机访问光源表和 cluster 表。

如果没有 `TextureBuffer`，这个项目在 WebGL 1 下几乎无法优雅地把“动态光源数组”和“cluster -> light list”送进 shader。

---

## 7. README 中性能结果的实现解释

### 7.1 Forward / Forward+ / Clustered Deferred 对比

README 的第一组结论见 `README.md:30-34`：

- 光源数量增大时，传统 Forward 越来越慢
- `Forward+` 和 `Clustered Deferred` 显著优于传统 Forward
- 当光源数大于约 500 时，`Clustered Deferred` 开始优于 `Forward+`

这和代码结构完全一致。

#### 为什么传统 Forward 最慢

传统 forward 片段着色器直接遍历所有灯，见 `src/shaders/forward.frag.glsl.js:79-88`：

```glsl
for (int i = 0; i < NUM_LIGHTS; ++i) {
  Light light = UnpackLight(i);
  ...
}
```

即使某个像素只受极少数灯影响，它仍然要遍历全部 `NUM_LIGHTS`。

#### 为什么 Forward+ 明显更快

Forward+ 仍是 forward shading，但把每片段遍历集合从“全灯表”变成“本 cluster 的灯表”，见 `src/shaders/forwardPlus.frag.glsl.js:99-116`。这直接削减了大量无效光照计算。

#### 为什么 Clustered Deferred 最终更快

两者都用了 cluster list，但 Clustered Deferred 还有额外优势：

1. 几何 pass 与光照 pass 分离
   - `scene.draw(_progCopy)` 不包含光照循环，只负责写 G-Buffer
2. 光照只在最终屏幕像素上执行
   - `renderFullscreenQuad(_progShade)` 的工作量与屏幕分辨率绑定，而不是与模型片元覆盖和材质采样路径完全耦合
3. 场景几何复杂度和过绘对光照阶段影响更小
   - 对于 Sponza 这种复杂场景，这一点尤其有利
4. 当前实现又启用了 2-buffer 优化版 G-Buffer
   - 降低了 deferred 的额外 MRT 成本

所以随着光源数增大，deferred 的“光照组织方式”优势会逐渐压过它“多一遍 G-Buffer pass”的成本。

### 7.2 为什么 README 中切片数在 15~20 左右最好

README 的第二组结论见 `README.md:36-42`。

源码层面可以这样解释：

- `updateClusters()` 的核心成本近似是：
  - `O(清空所有 clusters + 每个光源覆盖的 cluster 数)`
- shader 光照成本近似是：
  - `O(每个像素所属 cluster 的灯数)`

切片太少时：

- 每个 cluster 太大
- 一个 cluster 中包含很多灯
- 片段 shader 的 `realNumLights` 偏大

切片太多时：

- cluster 总数急剧上升
- cluster texture 变大
- CPU 分桶和 GPU 查表的局部性变差

因此一定存在一个折中点。项目作者实测为 15~20，和实现特征吻合。

README 还特别说明测试环境是 60 Hz 显示器，见 `README.md:28, 42`。这意味着曲线会受到 vsync / 帧时间量化影响，适合看趋势，不适合当作绝对吞吐极限。

### 7.3 G-Buffer 优化为什么能带来明显收益

README 的第三组结论见 `README.md:44-58`。

从实现看，优化收益非常直接：

- 未优化：3 个 `RGBA32F` G-Buffer
- 优化后：2 个 `RGBA32F` G-Buffer

减少的不是一小部分数学量，而是整张全分辨率浮点纹理的：

- 写入带宽
- 读取带宽
- FBO 附件数量
- 显存占用

对于 deferred shading，这类带宽开销通常就是主瓶颈之一。因此 README 中“optimized clustered deferred 明显更快”是符合图形管线常识和当前代码实现的。

---

## 8. 从 `src/main.js` 开始的代码流程追踪

### 8.1 初始化阶段

`src/init.js` 先完成基础设施初始化：

- 创建 WebGL 上下文：`src/init.js:17-26`
- 检查并启用扩展：`src/init.js:28-50`
- 创建 GUI：`src/init.js:52`
- 创建相机和 OrbitControls：`src/init.js:62-71`
- 设置 canvas 尺寸与 resize：`src/init.js:73-81`
- 定义 render loop 包装器：`src/init.js:88-99`
- 最后 `require('./main')`：`src/init.js:101-102`

### 8.2 `main.js` 如何切换渲染模式

主入口在 `src/main.js:8-34`。

切换逻辑是：

```js
const params = { renderer: CLUSTERED, _renderer: null };
setRenderer(params.renderer);
gui.add(params, 'renderer', [FORWARD, FORWARD_PLUS, CLUSTERED]).onChange(setRenderer);
```

`setRenderer(renderer)` 根据字符串创建新实例：

- `ForwardRenderer()`
- `ForwardPlusRenderer(NUM_SLICES, NUM_SLICES, NUM_SLICES)`
- `ClusteredDeferredRenderer(NUM_SLICES, NUM_SLICES, NUM_SLICES)`

因此 GUI 的本质是：修改 `params.renderer`，然后把 `params._renderer` 替换成新的 renderer 对象。

### 8.3 场景和相机的装配

`src/main.js:36-53` 做了三件事：

1. `const scene = new Scene();`
2. `scene.loadGLTF('models/sponza/sponza.gltf');`
3. 设定相机初始位置与轨道目标，并开启深度测试

`Scene` 在构造函数中同时创建了 `NUM_LIGHTS` 个随机点光源，见 `src/scene.js:14-33`。

### 8.4 每帧执行顺序

`render()` 函数位于 `src/main.js:55-66`，顺序非常清晰：

1. `scene.update()`
   - 让所有灯沿 y 方向移动并循环回卷，见 `src/scene.js:158-165`
2. `params._renderer.render(camera, scene)`
   - 进入当前渲染路径
3. 临时关闭深度测试绘制 wireframe 调试线
4. 恢复深度测试

把它和 `makeRenderLoop()` 合起来，就是：

```text
cameraControls.update
-> scene.update
-> renderer.render(camera, scene)
-> wireframe.render
-> requestAnimationFrame
```

### 8.5 两种高级渲染路径在每帧中的顺序差异

#### Forward+

```text
更新相机矩阵
-> updateClusters
-> 更新 light texture
-> 绑定默认 framebuffer
-> scene.draw(forwardPlus shader)
```

#### Clustered Deferred

```text
更新相机矩阵
-> 绑定 FBO
-> scene.draw(gbuffer copy shader)
-> 更新 light texture
-> updateClusters
-> 切回默认 framebuffer
-> 绑定 gbuffer/light/cluster textures
-> renderFullscreenQuad(deferred shader)
```

这也正好说明了两者的核心差别：

- `Forward+`：光照和几何一起做
- `Clustered Deferred`：几何先写缓存，光照后做

---

## 9. 架构图与数据流总结

### 9.1 CPU/GPU 数据流图

```text
CPU
Scene.lights ------------------------+
                                     |
                                     v
                            ForwardPlusRenderer / ClusteredDeferredRenderer
                                     |
                    +----------------+----------------+
                    |                                 |
                    v                                 v
             light TextureBuffer                cluster TextureBuffer
             (position/radius/color)            (count + light indices)
                    |                                 |
                    +---------------+-----------------+
                                    |
                                    v
GPU Fragment Shader / Deferred Shade Shader
  1. 定位当前 cluster
  2. 读取 cluster 内 light index 列表
  3. 再去 light buffer 读实际 light 数据
  4. 完成逐光源累加
```

### 9.2 两条主路径的结构图

```text
Forward+
Scene.draw(meshes)
  -> vertex shader
  -> fragment shader
     -> sample albedo/normal map
     -> cluster lookup
     -> light loop
     -> output final color

Clustered Deferred
Pass 1: Scene.draw(meshes)
  -> vertex shader
  -> deferredToTexture.frag
     -> write G-Buffer

Pass 2: Fullscreen Quad
  -> quad.vert
  -> deferred.frag
     -> read G-Buffer
     -> cluster lookup
     -> light loop
     -> output final color
```

---

## 10. 最终结论

这个项目的实现机制可以概括为一句话：

> 在 WebGL 1 受限环境下，作者用 `TextureBuffer` 把“光源表”和“cluster-light 索引表”都编码成浮点纹理，再让 `Forward+` 和 `Clustered Deferred` 两条渲染路径共享同一套 clustered lighting 基础设施。

具体来说：

- `BaseRenderer` 负责 CPU 端聚类分桶，是两条高级路径的共同底座。
- `Forward+` 把 clustered lighting 直接嵌进普通几何绘制的片段阶段。
- `Clustered Deferred` 先写优化后的 2 个 G-Buffer，再在全屏 pass 中做 clustered Blinn-Phong 光照。
- `TextureBuffer` 是整个项目最关键的数据抽象，它替代了 WebGL 1 中缺失的通用结构化 GPU buffer。
- README 中“Clustered Deferred 在大量光源下更优”的结论，和当前代码的组织方式完全一致：它既利用了 clustered lighting，又通过延迟着色和 G-Buffer 压缩降低了光照阶段与带宽阶段的总成本。

如果把这份项目作为学习样例来看，最值得掌握的不是某一个 shader 公式，而是这三层设计：

1. **空间分桶**：把“全局光源问题”缩成“局部 cluster 问题”。
2. **数据打包**：把结构化数据改造成 WebGL 1 可读的 float texture。
3. **着色时机选择**：同样的 cluster 数据，既可以服务于 Forward+，也可以服务于 Deferred。

