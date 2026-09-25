# Rust P6 同机配对性能记录

阶段：interim-before-cache-backfill-fixes。生成：2026-09-25T09:24:59.950Z。

机器：Apple M1 Pro / darwin 27.0.0 / arm64；Node v24.21.0。每场景预热 1 次，正式 5 次；每轮每端点 30 个请求。

冷启动仅指删除应用 SQLite 缓存，未清空 OS 页缓存。测试期间其他 Agent/系统负载未隔离。Web RSS 峰值为 200ms 采样最大值；CLI 峰值来自 OS high-water。时间均为墙钟；CPU 原始样本单独保存。

完整记录及原始样本：[JSON](rust-migration-p6-before.json)。完整 JSON 等价错误及执行错误共 114 项，保留在 errors；有错误时本报告不构成验收通过。

| 工作负载 | 指标 | Node | Rust | Rust/Node |
| --- | --- | ---: | ---: | ---: |
| mixed-small | coldJsonWallMs | 244.12 | 57.43 | 0.235 |
| mixed-small | warmJsonWallMs | 161.53 | 67.31 | 0.417 |
| mixed-small | coldJsonPeakRssBytes | 124600320.00 | 22659072.00 | 0.182 |
| mixed-small | coldWebHttpReadyMs | 121.41 | 28.32 | 0.233 |
| mixed-small | coldWebIndexedReadyMs | 275.19 | 56.64 | 0.206 |
| mixed-small | hotWebHttpReadyMs | 146.62 | 28.86 | 0.197 |
| mixed-small | steadyRssBytes | 201555968.00 | 29376512.00 | 0.146 |
| mixed-small | sampledPeakRssBytes | 203194368.00 | 29507584.00 | 0.145 |
| mixed-small | appendVisibleMs | 982.76 | 196.57 | 0.200 |
| mixed-small | listP50WallMs | 1.02 | 0.38 | 0.377 |
| mixed-small | listP95WallMs | 1.46 | 0.59 | 0.404 |
| mixed-small | searchP50WallMs | 3.13 | 5.44 | 1.739 |
| mixed-small | searchP95WallMs | 3.72 | 6.04 | 1.624 |
| mixed-small | searchUnicodeP50WallMs | 3.03 | 2.87 | 0.946 |
| mixed-small | searchUnicodeP95WallMs | 3.61 | 3.47 | 0.963 |
| mixed-small | detailP50WallMs | 1.51 | 0.84 | 0.557 |
| mixed-small | detailP95WallMs | 1.90 | 1.14 | 0.600 |
| mixed-history | coldJsonWallMs | 1792.88 | 1272.72 | 0.710 |
| mixed-history | warmJsonWallMs | 199.47 | 1670.05 | 8.372 |
| mixed-history | coldJsonPeakRssBytes | 317931520.00 | 85803008.00 | 0.270 |
| mixed-history | coldWebHttpReadyMs | 145.97 | 28.17 | 0.193 |
| mixed-history | coldWebIndexedReadyMs | 2016.96 | 1567.95 | 0.777 |
| mixed-history | hotWebHttpReadyMs | 148.26 | 55.80 | 0.376 |
| mixed-history | steadyRssBytes | 390873088.00 | 142557184.00 | 0.365 |
| mixed-history | sampledPeakRssBytes | 412532736.00 | 144621568.00 | 0.351 |
| mixed-history | appendVisibleMs | 7950.07 | 198.20 | 0.025 |
| mixed-history | listP50WallMs | 4.28 | 3.32 | 0.776 |
| mixed-history | listP95WallMs | 5.06 | 13.24 | 2.620 |
| mixed-history | searchP50WallMs | 14.22 | 14.66 | 1.031 |
| mixed-history | searchP95WallMs | 25.39 | 27.06 | 1.066 |
| mixed-history | searchUnicodeP50WallMs | 14.04 | 9.75 | 0.695 |
| mixed-history | searchUnicodeP95WallMs | 25.00 | 17.93 | 0.717 |
| mixed-history | detailP50WallMs | 1.77 | 1.50 | 0.847 |
| mixed-history | detailP95WallMs | 2.38 | 7.84 | 3.291 |
| large-single-file | coldJsonWallMs | 930.40 | 488.48 | 0.525 |
| large-single-file | warmJsonWallMs | 160.31 | 569.70 | 3.554 |
| large-single-file | coldJsonPeakRssBytes | 364773376.00 | 52756480.00 | 0.145 |
| large-single-file | coldWebHttpReadyMs | 144.36 | 28.55 | 0.198 |
| large-single-file | coldWebIndexedReadyMs | 1007.19 | 545.26 | 0.541 |
| large-single-file | hotWebHttpReadyMs | 146.53 | 29.99 | 0.205 |
| large-single-file | steadyRssBytes | 552992768.00 | 104398848.00 | 0.189 |
| large-single-file | sampledPeakRssBytes | 645890048.00 | 250494976.00 | 0.388 |
| large-single-file | appendVisibleMs | 4636.49 | 839.69 | 0.181 |
| large-single-file | listP50WallMs | 1.70 | 0.80 | 0.469 |
| large-single-file | listP95WallMs | 3.90 | 5.52 | 1.415 |
| large-single-file | searchP50WallMs | 14.98 | 15.00 | 1.001 |
| large-single-file | searchP95WallMs | 16.64 | 39.06 | 2.347 |
| large-single-file | searchUnicodeP50WallMs | 14.52 | 14.36 | 0.989 |
| large-single-file | searchUnicodeP95WallMs | 15.68 | 27.30 | 1.741 |
| large-single-file | detailP50WallMs | 53.64 | 48.91 | 0.912 |
| large-single-file | detailP95WallMs | 62.12 | 70.65 | 1.137 |

`regressionScreen` 仅标记比值 > 1.2 供定位，不是新设的验收阈值。计划未约定统一加速倍数；不得据此忽略较小回退。大文件详情样本包含响应体接收，未计 JSON.parse；端点 p95 使用所有请求样本。

未测项目：浏览器可交互时间、最终安装制品下载/解压体积、查询计划、物理写入量及解析次数。P4 backfill 并发流量测量需最终候选补跑。SQLite 写入引擎版本来自各后端缓存文件头，编译选项未暴露。

## 错误与回退

- mixed-small / equivalence / coldJson：e7c9bf30ff2c613bade4b442bb509fbca7d675d470e9812d0528f543b6d82c4f != e25600e4feb3723b44c07b427198412b403d11b8362dd053354442d2762983da
- mixed-small / equivalence / warmJson：e7c9bf30ff2c613bade4b442bb509fbca7d675d470e9812d0528f543b6d82c4f != e25600e4feb3723b44c07b427198412b403d11b8362dd053354442d2762983da
- mixed-small / equivalence / list：9cc18f16c1d4a3528f9373bfb3e01204b541caaf31bf563b921a291f22677314 != 92cea95fe4c9ecfafb8eb7422812b403b9d74b6f0ecdbecea778278c293327f6
- mixed-small / equivalence / search：7f7b560b80f6c4a171d61ce6595a808a990294c6897ec6654335bc7c7fbb0e03 != 9f4351d78de8d5cfb60f1841cc1b44e1e11e54284e625ff989675784646b8bfc
- mixed-small / equivalence / searchUnicode：5f592443f930a1c807ec6e4c9e4b23befa36d889baf1580d188ff52dbc8fc66f != c6c908c296099bdb4b235e798faf1c78840551b46818325e42b01c09a8a42425
- mixed-small / equivalence / detail：474c3e6e5d7cf55e1447584a0a838897abd5eef96d67ce4bdcfff8d1da7772f1 != 2a954998b8ee122d1f2f0444f5df4a75615a0553f48c5c9196b97d2579758b15
- mixed-small / equivalence / append：dbd075ea8881311047871b46e2237aa8a6e99e67b893b15eafda1ef0d7975238 != 0c516c6c8fb8ed79fc8d1f7993c1c5f72437df33721b58cf2df1d09b7530f266
- mixed-small / equivalence / coldJson：a0d3745a7c953e42f083308688fc814249735ef38dfc387724f65fac2de5ec83 != 99466ce6b194ae4f45b560f43ae89ab5aa5d6256884e23e4aa6f71e46f3c4074
- mixed-small / equivalence / warmJson：a0d3745a7c953e42f083308688fc814249735ef38dfc387724f65fac2de5ec83 != 99466ce6b194ae4f45b560f43ae89ab5aa5d6256884e23e4aa6f71e46f3c4074
- mixed-small / equivalence / list：b90f1ea8561c04c92fd660871d4fc1d8e76c52a7877c1008bdc8098835eb73a2 != 09d2e4706791623b09a0670ecd9b79e507a57fc4f766680967ded6524c1c6cc7
- mixed-small / equivalence / search：9c84f48706f94bf8ff3f855d910f64ae2147ed03338f386854d51b64bb16166e != 0502f4f49be080e8968a2364d943f7a324f106feca166f3dbb431e54103974c1
- mixed-small / equivalence / searchUnicode：6eb8fbfa2024b5e64238f681bf31fdc97d9681af78c904c0177708f6eee42af7 != 31f54db5c96004bca966ca670c026a42ae6a0b11641a0dddbf87442794bd5380
- mixed-small / equivalence / detail：537c4a79f906d3428e57608b3505434b0e802cdbcf1ed19bdcd20512b50f1432 != d56290671ac3cb157da8916a4acff907d8d323a012e60342eee1e45b4898f1aa
- mixed-small / equivalence / append：c4bac15e0811558bd14534d7daa2e252da2a1b64fb75f93213547e2e2c98259a != 7924e5bfa4129e09ee39aefccfd9a6734731489980eabb924908ede471939243
- mixed-small / equivalence / coldJson：a9a3df9e205abc32e457dacb7d9f256081ecefa3541338a235a09318719e7936 != dd3994c6de92cc21df8db04d5918d0ec9a923f92e5e1e58f459214db70b08027
- mixed-small / equivalence / warmJson：a9a3df9e205abc32e457dacb7d9f256081ecefa3541338a235a09318719e7936 != dd3994c6de92cc21df8db04d5918d0ec9a923f92e5e1e58f459214db70b08027
- mixed-small / equivalence / list：d5bbfe8ecad0f6bada7d3acc843260ead87d4d603b010bc093d49cc35d4bf8b5 != 52338a58f8760c20de33efc700b55f63f604243b6eb1da0f8e457616e1ece5de
- mixed-small / equivalence / search：157ec240a0e885698ad32cbbdf6dbac6d2493d0d7969980fd2704793a62172cd != eb487563bd1ccf300e26f706c093fa4b20ef998212e2dd1b5c6b84dc7a1bbc91
- mixed-small / equivalence / searchUnicode：15b1fc4f17ceb38f03641ad5066aaa6a37f472f44e01240e7117d33fcce8a01d != 52183298510df39af9d692b217ea0b2d198483c5935c67d817b1c73963d6d9a4
- mixed-small / equivalence / detail：87d2086918b7a1f3495ce147c2da70db28a72aead3312b9bb97dd54dc25f1cd7 != 45bb866d0ca9999f2a98fca6e33d315ca5414c9802e3dfa929bd23ae8033040e
- mixed-small / equivalence / append：7d07f7527c44f76d49d78bd9e84952782e62eda0546079bd5fcaf13c111c0bae != c51364f1efe2bbac1bcee536d17d643c399ffb86bf494fc4f443ef11a627ae38
- mixed-small / equivalence / coldJson：1fa4f4e6d09ec799f71e193afa64e6b60941c73d02aac3cf41eefa19a831c34a != a5dc060d73efbefada01acdb2a4f193f74c985f80e92118d36b160a650ce68a9
- mixed-small / equivalence / warmJson：1fa4f4e6d09ec799f71e193afa64e6b60941c73d02aac3cf41eefa19a831c34a != a5dc060d73efbefada01acdb2a4f193f74c985f80e92118d36b160a650ce68a9
- mixed-small / equivalence / list：cf2790683f593d05117045130200abb54f22c4de03112246f63137180973b14b != 2534288370e3bdbf767484954b8720d2933e7dd2905cad7ee93c852d7de820c9
- mixed-small / equivalence / search：6afff5d85568b7e5272979b654649b993b613c70546ce6732b370e23bc4028ee != 67839f914073357828ade4fb3c11ba48dc83874fe1a481ce8e1f0f1eaa9bd01e
- mixed-small / equivalence / searchUnicode：c029800b3ffc3cb314bb6f252cedda011cc0a1ccd09e760ba5678910b6884bde != 9690376d7e3ce82937d21bc810c161bd51718fca8bbb887d34a470fe46c732e6
- mixed-small / equivalence / detail：776a1429f458663c1eb2d89d4a9ecdf4095814bbf9c62ac7f86cc64872fa6f5e != 118a98ac0b4f81f8bb032a76d8ffc95704319f2eb740c73d629d51c948cc46cb
- mixed-small / equivalence / append：f893ea34c659efe70b273dfeeebe1490dffbe08d806527d76d710e95aa378ab1 != 965ba141f41288bb2c539705af02acca5f2239cd2374fef8a2dc0dd60d15165b
- mixed-small / equivalence / coldJson：24e79936dcb173d8801b6de028118ffebf57e1b444ea4911b20a304cb1d4c457 != 2cb2413f5963911471ef40d15760c771a1243eb0f24c2ca40c4425409dab8e30
- mixed-small / equivalence / warmJson：24e79936dcb173d8801b6de028118ffebf57e1b444ea4911b20a304cb1d4c457 != 2cb2413f5963911471ef40d15760c771a1243eb0f24c2ca40c4425409dab8e30
- mixed-small / equivalence / list：ea96603f4eac5d2cc3113178ba5eabafacb9a631c11bb54910a5833f3605ac2d != bfd446f7677c100923ccab61a3a2ee040b203e90b1840e77a763325aebcf391f
- mixed-small / equivalence / search：ea8d04aa7f1a0024a80174a03130e516154a33647e51558a2064dec3e68f4352 != 5648eb5711cc813625b6dc46098765ef0518ea26796b0c7752b5948398ae68fe
- mixed-small / equivalence / searchUnicode：0cc6699cdb77a81924d3ce4b08fa5ad0ca6c4265d974e3b2dfd9dd036e11aea4 != 47ccaf250f3456a4ce15b5c071da92da8e1038275ddc90f52f396524923f7d74
- mixed-small / equivalence / detail：6280f667279b0cf7f3de1f9357b55174b096e11a9c10c23591bee6cf48cd02c0 != 06600eab97d3ab7bdf0be3ca28dc0b2c5dfd4a25b6f92cf9e25a284955961bd0
- mixed-small / equivalence / append：d0ceb282083cdcd57ad6f05b5f1c95944e12c21271f618a609c558c36d37914f != 5c445c672f116a958116e77efae97b5530d6b0398e6dde0397683ec6d07e2606
- mixed-small / equivalence / coldJson：3929d1650c876c3f826c770930ffbe8efa129b40892125c7ca65a9c094012ac0 != 37f6536060147d5680f1d859bfaf170e0738fb6c594ded814ba6bfa7a2277063
- mixed-small / equivalence / warmJson：3929d1650c876c3f826c770930ffbe8efa129b40892125c7ca65a9c094012ac0 != 37f6536060147d5680f1d859bfaf170e0738fb6c594ded814ba6bfa7a2277063
- mixed-small / equivalence / list：3d6d7033aa092cfe82f54c7cb8022950812170681ceccc7e411f7ea49259444d != 40e1b23dd380a6bfa816bf6d1b0fa5b9b2f6fffd269fd128a8c5aaec87b414e5
- mixed-small / equivalence / search：f85f0c19bc2317ecfc56b264f2cca64a022f38668c812219e56add703908befa != 8fdac58d9856eb43b75ff84deff2ec36e97c103f3c5715e96e8ef73f6cef8e3f
- mixed-small / equivalence / searchUnicode：454f80b4c4f4c095c9c1febfad52c62bcc12f98d4d44e16a20a913eb828fe633 != 951b0fcc325fe6c6005094f7cb4214cf386503b6934172b36488e49c33ac1b0f
- mixed-small / equivalence / detail：80b366d44fea236b7ff70a858757ab9082e665adb5691bf78fd6b744a39c2f5b != 0650bfafe74cd1c5b95380927a6fc3dc33f8151fac53bba29debf828a264bd58
- mixed-small / equivalence / append：61ea850ac27b9b4efaa082a6088b17b989d12e3002290abbfbc99600e382efd9 != 8eb7cbf5ca91a3e5dcf13594b8a2f5f8c39468b7ed4f9e821e9e2b2af0fdfab9
- mixed-history / equivalence / coldJson：72d6f57016f8a661961c078d347bcb3df9307927cbb8cbe70d15c5f13025595e != e00348905bf9d1e4a7d3ca8139d8552cf613e8cf36595bee96e07cb1b50989a6
- mixed-history / equivalence / warmJson：72d6f57016f8a661961c078d347bcb3df9307927cbb8cbe70d15c5f13025595e != e00348905bf9d1e4a7d3ca8139d8552cf613e8cf36595bee96e07cb1b50989a6
- mixed-history / equivalence / list：8c917b5949ec5ec5085f95c610f14b8f746e42f383de24ea0c275e7c1a2addc7 != cb6e7e7d465f559bcb82222ae4cdaf740159828f82033a164f554ee130a27943
- mixed-history / equivalence / detail：900c29cc186af2a9493ba20b378795675d1c2d73d5d7462eeae9d80c32002620 != 1342702a012e2873803e314e24eb1b39ed57c1d774cec06fa8f3001e18ab8097
- mixed-history / equivalence / append：75b3784257acf954e1a3d653df2fd75b2d54732df91fb455dfbde0e0ef373561 != 0fad3eb6cbe003e641013f10c759e4a4e1afaeda2bf57516d78268c1c5c5a02d
- mixed-history / equivalence / coldJson：2075942b50423cf816e11e9d6da6f8ab10a14b878cd5ae611873394f0754eb69 != 7ac97071f7fa98ddabf2ad9bebaa604bbffbd66edcdde5b907db5a7a0f3b15e5
- mixed-history / equivalence / warmJson：2075942b50423cf816e11e9d6da6f8ab10a14b878cd5ae611873394f0754eb69 != 7ac97071f7fa98ddabf2ad9bebaa604bbffbd66edcdde5b907db5a7a0f3b15e5
- mixed-history / equivalence / list：f33ed418755c9da128fc0ccf1227ff0065339217cb2eb7eae698f37b2ae7296c != b85ccf370702fa842dee079f61fef066c76ab2d25bfb5dfa26afb0c95d961c38
- mixed-history / equivalence / detail：c441623d513b567ff6711caf0b0f99da6cf8fa3a9bfeb7a05b8891f7dbab8a59 != bf0097b10b51403cab7ceffc622aaef53f9f6a477096476583a1d66b0734c5e4
- mixed-history / equivalence / append：f609333f10aa3f2c0f099946fa02bbcf54f578d2b454d49ec22a9b8a0b0e95f3 != 41c4f7beb8f612745f63be5b3b7f39b014aa30c42bcadf1c4ed9f0c36e47096e
- mixed-history / equivalence / coldJson：10df94904c378125ac1a973521fe90d7eb192c8c3b5c02cc01d478517bd63451 != d7f21b6dc85e8495d0387fb3b42a428b383c441934159a35085bb0ebb46c69c7
- mixed-history / equivalence / warmJson：10df94904c378125ac1a973521fe90d7eb192c8c3b5c02cc01d478517bd63451 != d7f21b6dc85e8495d0387fb3b42a428b383c441934159a35085bb0ebb46c69c7
- mixed-history / equivalence / list：9e7e81eb058ad4b78f5466990cdb19894e28543014b9818cd782639dd5455e95 != 252b41c4dd9e2e3466f031e025f2a04b9bdd2082a09f6af8d698b63583190e9e
- mixed-history / equivalence / detail：279cac4d75382e0019653ba1a6ba0b01da080a23188926dcf35391908035d886 != 5d99966dec6d23ba474aaad2f4ade9da251ed3040d194c4303656160e10c9263
- mixed-history / equivalence / append：39c0dd4baf5b04a94466d4736254260b5fc2db4a938984b2ae00a5b29fbb6f2b != 5e60ba151e4787cc1e6cdcb2cb738f5fad77a11c95eea15513e050818b1c39c6
- mixed-history / equivalence / coldJson：8960c936b42b41fda55a033bf4e0d27e4ee645176e76cf582eb0d4de1f24d15f != a05a9a15d8bc5983715c8cd3b0be8c9bbae2749f4a6334da289cefba8dbe427c
- mixed-history / equivalence / warmJson：8960c936b42b41fda55a033bf4e0d27e4ee645176e76cf582eb0d4de1f24d15f != a05a9a15d8bc5983715c8cd3b0be8c9bbae2749f4a6334da289cefba8dbe427c
- mixed-history / equivalence / list：16fa43c2607636d30eb05033056aff353e288b90cd1341f49d6e2388efd5d0c1 != a9b7df2ab9347c01f16f2cb198cce46bfdd6171c1e7c7d90009513b4da82ddf1
- mixed-history / equivalence / detail：68f45f8407a4892366b5c9be7e0c8aed7586d2a923f59cea6f146134de678a08 != 2ebafba84718279f053f80035db5dc088463f1917b02acf2b1aa99beb4a3b38e
- mixed-history / equivalence / append：4db4748d8db87b2bbe365c9df5ed4d9e85ef353db09af4ac8198c8848ab2f7b3 != 6e1c4303d74751cf54648e91d8d8a9a9e9a00c015784d96d7a421dfc19a35f47
- mixed-history / equivalence / coldJson：244b337cff590ecb5c835ef3f785621e659592095f3424dcd254c339bf84576a != 3d457e1dd31b0aadc03b08e2bc327f3040117dea9e1867b07d9f003c585e30df
- mixed-history / equivalence / warmJson：244b337cff590ecb5c835ef3f785621e659592095f3424dcd254c339bf84576a != 3d457e1dd31b0aadc03b08e2bc327f3040117dea9e1867b07d9f003c585e30df
- mixed-history / equivalence / list：77f34a67b33ac8551791cfeab0b9a41d1169ee605b2c5b0ed7889884e22ba25a != e5e3ebefbfa755d77acc3da328b74fcd43071e8fb627b35938e1e6050c461850
- mixed-history / equivalence / detail：13a0be733821ad27fb4911f3f8bf03e2f04be817b59758ab176712a111bed88b != 3b5bb3dc08fe9db3bfdd00915d88dcbb58b07113f9b120b624a59eddef34641f
- mixed-history / equivalence / append：d080b856a769ff0b6a9f8de86d3eafc2cae5e6325c70f7d5e28693c68e4c26ee != 23f3fdeb9bfd7745ab55587b536060cfb58ca4f68fd065b8fd19f1dd9e255fc5
- mixed-history / equivalence / coldJson：b855a94869e5b244702bba18a76881ad71709112b99da697648938e4128de7e8 != 0ac8627f8e2736c22c83e9d1798145cb7a6af2e0054adbf6c39c6c8b0f294530
- mixed-history / equivalence / warmJson：b855a94869e5b244702bba18a76881ad71709112b99da697648938e4128de7e8 != 0ac8627f8e2736c22c83e9d1798145cb7a6af2e0054adbf6c39c6c8b0f294530
- mixed-history / equivalence / list：4f7213ce2124d0e9b039b1e4c07dfaa1225b25e41a970539954e9498ad6c5c5b != 6957221b62fdb2bfd0fe9ca42a2ccfe64d3ccaa6a3cc62f472414a47636c23eb
- mixed-history / equivalence / detail：2b2f464ce3723b8f5bbf5d375f7d1e5a1593b5ef65e17a3c6c98855b34b5de2f != 92edc9a2792a04c2987af3b10adf8605968264c673a8dcac9f6726b9c2793fc0
- mixed-history / equivalence / append：4908b9ae85fd9a7e0c43de805855cc32db9dfeebb9a4c14147abd616b5c2ae04 != 2c30c9d142ad548cfcef73284d5bf143022b0d03c15959895cb707550c61dc64
- large-single-file / equivalence / coldJson：acad5aa0b332e933ed6e14ec998d44b87e08771fe6f2a8ba9357f1a25d2ee283 != 83307243cd0c4e5bcfe2267bad7e4f5054677238f2f342b1580697f423255f4d
- large-single-file / equivalence / warmJson：acad5aa0b332e933ed6e14ec998d44b87e08771fe6f2a8ba9357f1a25d2ee283 != 83307243cd0c4e5bcfe2267bad7e4f5054677238f2f342b1580697f423255f4d
- large-single-file / equivalence / list：bf6244857bdeff9bf78b8fd15cfbd6dbb2e1d5cd5b1e00f53572a50e1ae0bfa4 != 2e2646c67414b580a2dd9be37a2054401e3d89b515098df9cc42eb89ce8f67ca
- large-single-file / equivalence / search：50320be6519a9ce636c01ec23a73d39a1407571294d9392d0f1be2643624d9ac != 5714bd82fd8f22b11c06e74b9b50ea4858d9e8bf8708564d27f1d126a78c1626
- large-single-file / equivalence / searchUnicode：8ca6be4201c55e8372f875550f40fec1c9de18735f1678b484580ded5e2ebe50 != 265f005b0b81c45eb1eaa26c3ca9722d402d52a39a310baf78b5888aa4213635
- large-single-file / equivalence / detail：4592c53736be598934d06f6b63afcd37e3d616b2bcfbaf65f1fd14b0b3806168 != 1c24f0f41d9a3477de4bde77785b00e17b03b4f87d9775f62508d959ea220504
- large-single-file / equivalence / append：6cf64070c510184df554b17846d88b0276c09d5d755a3cd6e90b2850c25bb26f != 5bdc19f9563b96ecd14ecee7e33638c756e48896321801fbdba37f65ab39cb6f
- large-single-file / equivalence / coldJson：cebe30a194db0a0d6a0e7e4a1f8f73e7bcb9ce248a6da1ddb193c5c0447f40d8 != 48b4ee858301deadbc55f81fb7b943f8aa543ff029aad92478d3313127ec7f50
- large-single-file / equivalence / warmJson：cebe30a194db0a0d6a0e7e4a1f8f73e7bcb9ce248a6da1ddb193c5c0447f40d8 != 48b4ee858301deadbc55f81fb7b943f8aa543ff029aad92478d3313127ec7f50
- large-single-file / equivalence / list：6ab47d8f0e3bbd0424c194fc11ba0b1b71129f771afbe7356a1c6554ec01963a != 1978e3ad9045cdbfa623956219dc4b3381cf34485c539f9e3fddb47ac6242380
- large-single-file / equivalence / search：e37bb8c16fb6bddfb592093a507f886c376e4d5d6a20e2ba4f76687cba731965 != bc2870630fcd3528bfeaa4697a6d5eaaaf3da8a8ead17e62ce65e7a755c2de12
- large-single-file / equivalence / searchUnicode：2e961bb7d2491648412506674e56be32dece957d94641158b729da7a246d3d05 != a3558468b7eb522e2139a7236e9ea4d468786b2e9c2970efa004e5e283287af1
- large-single-file / equivalence / detail：6a1d57433309c7c5f932bd1c481a860f96fe28de494d88a7fd107c686a96046c != eb8f1d71073dba9c1bacf000f198d4e065e24ed0cef2df15359887a323483ec1
- large-single-file / equivalence / append：794163dfbb0dd438b7eac585700ae92634cdbcf51ba01a706b9e28045000e35f != ae2e2f137a5043285932c6b7948b82438e8718e6c9ce1e93025cbc75288c9f74
- large-single-file / equivalence / coldJson：d3720586874bcfdbd826e1969639a387eca4c62ea0aa12bd96ac3a31bb69091c != 9218b034e16f009bf23229d6c787e082a82e67e0f7ec9a5e991e751ab03dd47e
- large-single-file / equivalence / warmJson：d3720586874bcfdbd826e1969639a387eca4c62ea0aa12bd96ac3a31bb69091c != 9218b034e16f009bf23229d6c787e082a82e67e0f7ec9a5e991e751ab03dd47e
- large-single-file / equivalence / list：54b238c095e4413fc739a5cb600732ac6871220e94b28828f3b379dd2cfa8676 != 88527dbd994478e8207a01f168c68bcc70a85b4d1a3de66ed377ac0dc014d96b
- large-single-file / equivalence / search：a96f7baf986dc46eae91d7959f1b565f37346af6607966886b8da0c1e30ebbf6 != 7d7e212d22ba32eea32937524ff8833d6d5e1043d95b02124b0a688523bfac19
- large-single-file / equivalence / searchUnicode：58aafdaacaaaeb24fca6c75fcc6c32ab6362d380f4edd9a1ab84bab59338dee2 != 3d7573962ca316e8a096cad7abe5ab1d7657d645fb1e2794c795c49a4b5b5c5f
- large-single-file / equivalence / detail：66a9957f39257d68b101d77079437b817db0e196329e675e5cdda677708ca791 != 2eb47b48dc7248997d0a76406369d5fce361d4353aec0bda9776ffe9cb315640
- large-single-file / equivalence / append：4e6507c4ec78c95c4b5e14a5e1a6209f27aaca868231de38960dfd3be14bd7b4 != f2d76c063414fb2a45f7c0ae052ef63877b55cc5dff0152f2bd55ae60519966b
- large-single-file / equivalence / coldJson：5974de14a075be43fc1b46d4e149f9b75425483295fcd1b116e93efffc2739d5 != 82072e356454c23296cea3e906cf59da2d1eeb7123cf2d2ea74d2de5250b88f4
- large-single-file / equivalence / warmJson：5974de14a075be43fc1b46d4e149f9b75425483295fcd1b116e93efffc2739d5 != 82072e356454c23296cea3e906cf59da2d1eeb7123cf2d2ea74d2de5250b88f4
- large-single-file / equivalence / list：806f51b74e431069cb4ce0f4727c5ca971d89ea45b3f9238fb44e0c182faf973 != 789ca7f98ee857b1d222fafda02491525153fe4a2492a0b666b6b235a764aa08
- large-single-file / equivalence / search：167beaeceeb02e73934d706aea5004449cb1195fa888b20b1ad8bc5278095f99 != 213f2c7812d7504e5a3059eca06ba912bc1953ae9477b37bece8221dde2ae6e8
- large-single-file / equivalence / searchUnicode：7652f8ff75a3c6f592fdb297a04540465e5f26044cab06601bb60caf70070191 != a3708609727f83dae482b790c563cf6e12de09f8c19edd30661e70e7046d6556
- large-single-file / equivalence / detail：1611137152d92995f07335f03cc00350b0b803a338df9e035ab5c358aee110c6 != c3344cd403f26606d04d966a98be4c4113b74637f7afcac067f526da4832eb4c
- large-single-file / equivalence / append：9abd3a4d90db40d261191aa9971a1add6166b671af9e7cc438b6d1496c1742bb != a7c86ef54c5a560a9d8c07407e3ab1cbd3c8da04ee7dddb50216509dd29c2544
- large-single-file / equivalence / coldJson：65226c427f950783e4875dbbb6128de9a1072148513912e46acb80de90e5737a != 9ba4c68a3a4ce1244b09f10db0ff53c74f77988ad3fe03be71258fe9c633aef1
- large-single-file / equivalence / warmJson：65226c427f950783e4875dbbb6128de9a1072148513912e46acb80de90e5737a != 9ba4c68a3a4ce1244b09f10db0ff53c74f77988ad3fe03be71258fe9c633aef1
- large-single-file / equivalence / list：10e865248b28a30496fc5b25c4a844c360bed2277d0bd9bf3959e9fd573b471a != 83db98d0f2668f86a119a5aea94420f7ef3a3f7839a2461ec52384b830f49464
- large-single-file / equivalence / search：8028de815203beaafc648f6ae42787793c73e74405ee6e70b2005b796adb209d != 8612a1926f6da219686feffa31dbe6f4c6e112a351df6d438a3a8f87c72dde9e
- large-single-file / equivalence / searchUnicode：da760250234a7ec3c09f2b18095460466e19a5445d2be5f5c7b0573fb6f92547 != 15348cbb4eedd6820aacfe35edc1965fdb903f11ee23135b1f91d8b92ed44246
- large-single-file / equivalence / detail：49860a87c932777c0667b29af43b0956876dd26c091d4b439a80ac242d9dedad != 6417c9e60e210eab6028ae6dee2123ecd487c3c1861dc4afed0e088e34cf3d6d
- large-single-file / equivalence / append：1cf94b72886198b0feaa8667f26a642d1ef8206be6b896227de8bfccb4fe1e8f != dcd8e1cc69ccd1b543949d39fd84babca602aaab91cfcf71a37db6b483e9640f
- large-single-file / equivalence / coldJson：c6722bd6a8427dbf41e2579946ff30286f6a886a62b5926cb19c05ffc5b7e91a != 9b140aca4e1c7bcfb28ef736a992a1c39c8fb065aded4de8c0683f1e1bc9ed58
- large-single-file / equivalence / warmJson：c6722bd6a8427dbf41e2579946ff30286f6a886a62b5926cb19c05ffc5b7e91a != 9b140aca4e1c7bcfb28ef736a992a1c39c8fb065aded4de8c0683f1e1bc9ed58
- large-single-file / equivalence / list：a2c752c749cffd2c7e4b948025a7f200d0f0a68d319445c6b9056112bb8c31fd != 20bec18ae2e93196fffadc52d098350dc458792b40dab446c62d3b583c840252
- large-single-file / equivalence / search：0fb45a035bce244cd9ab1aa6183ca0ba22d0d961c6379551dab2f45746b6b56c != 2dde71c7bd1ef6c665f21a9cf2717f975b1e364fa6cd77f957e480dff50446a0
- large-single-file / equivalence / searchUnicode：b4e73f1a200c68b0fd32d969229445510133b7c92a1e9a4b1e36ddae0a9139c9 != 23ee8dd7aca663bccc6710a9b9ed6b170c93907ef259fd395b022f08fc76f90d
- large-single-file / equivalence / detail：d2054fc4c01226a845b5f33d19478ad057da6676c2b8118977e93c4bebe4a123 != 0e35143a9e8894c84b7f44ee26a6b86f9de57194d0e7c356beac3ec43c4e86d8
- large-single-file / equivalence / append：c94fbf3989cc3b008d856aa5b43bf088b9f9f57d13ad0b88fbbda80cabb81bdd != f15db8b56c1b60705d196e99c9aef50dc17926f62f56af267f69f1eb6894b331
- mixed-small searchP50WallMs：Rust/Node 1.739，需要定位。
- mixed-small searchP95WallMs：Rust/Node 1.624，需要定位。
- mixed-history warmJsonWallMs：Rust/Node 8.372，需要定位。
- mixed-history listP95WallMs：Rust/Node 2.620，需要定位。
- mixed-history detailP95WallMs：Rust/Node 3.291，需要定位。
- large-single-file warmJsonWallMs：Rust/Node 3.554，需要定位。
- large-single-file listP95WallMs：Rust/Node 1.415，需要定位。
- large-single-file searchP95WallMs：Rust/Node 2.347，需要定位。
- large-single-file searchUnicodeP95WallMs：Rust/Node 1.741，需要定位。

## 连接池优化前的中间候选

JSON 的 followUpCandidates 保留 SHA `abce880aeebb330838a35a8eab7e4a816d003487fa695fd71cb6270bd3f5b9f1` 的完整 5 轮主测、5 轮额外端点与发布暂态诊断。暖 JSON 已改善至 19/33/19ms；small 搜索 p95 3.93→7.24ms、projects 1.68→3.17ms、dashboard 1.92→3.85ms 的回退均保留。

主测 3 次首次 body 可见时的完整摘要差异没有删除。独立大文件配对复现证明 Node 在 4800.448ms 已返回 10001 条消息但 head 时间仍旧，4869.760ms 收敛后全 payload 与 Rust 相同。最终评估分别记录首次消息可见与 head 发布完成时间，并在后者执行完整等价比较。诊断 3 轮大文件、1 轮混合历史及额外端点 5 轮稳定发布比较均无差异。

## 聚合查询优化前的安装候选

完整原始记录追加于 followUpCandidates，binary SHA `25b0d017191932ffa5472785320f92f05288d36a8544e92d17e9319d1c04b1e8`。3场景各5轮、7HTTP端点各150个正式样本，稳定发布后的全字段比较0错误。600会话 projects p95 1.665→45.610ms、dashboard 2.046→62.101ms；大文件分别1.810→14.723ms、1.924→19.247ms。这些真实回退阻止无条件通过P6。
