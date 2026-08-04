// 받은 조각을 디스크(OPFS)에 쌓아 두는 곳.
//
// 왜: 전에는 조각 전부와 완성본까지 메모리에 들고 있었다. 4K 로 긴 구간을 받으면
// GB 단위로 부풀고, 탭이 닫히면 받은 것이 전부 사라졌다. OPFS(youtube.com 오리진의
// 전용 디스크 저장소)에 조각을 흘려 쓰면 메모리에는 한 번에 조각 하나 크기만 남고,
// 탭이 죽어도 조각이 살아 있어 같은 구간을 다시 받으면 없는 것만 마저 받는다(이어받기).
//
// 이름 규칙이 곧 색인이다. 일반 영상은 `s<시작바이트>-<끝바이트>`(sidx 가 정한 조각
// 경계라 세션이 바뀌어도 같다), 라이브는 `q<조각번호>`. 목록 파일을 따로 두지 않으므로
// 목록과 실제 파일이 어긋날 일이 없다. 쓰다 만 파일도 없다 — OPFS 의 createWritable 은
// close() 때에야 원자적으로 자리를 잡는다. 파일이 보이면 완성된 것이다.
//
// 얼마나 쌓이나: 받는 동안 조각(구간 크기만큼) + 조립된 완성본(구간 크기만큼)이 잠깐
// 함께 있다. 조각은 저장이 끝나면 곧바로 지우고, 완성본과 남은 찌꺼기는 이틀 지나면
// 지운다(cleanup). 상한은 우리가 정하지 않는다 — 브라우저의 오리진 할당량이 이미 있고,
// 여유가 모자라 보이면 시작 전에 알려줄 수 있도록 remaining() 만 제공한다.

const ROOT = "ytdl-media";
const STAMP = "stamp";

/** OPFS 를 쓸 수 있는 곳인가. 아니면 메모리 저장소로 대신한다(이어받기만 없어진다). */
export async function diskAvailable() {
  try {
    if (!navigator.storage?.getDirectory) return false;
    await navigator.storage.getDirectory();
    return true;
  } catch {
    return false;
  }
}

/** 브라우저가 알려주는 남은 저장 공간(바이트). 모르면 Infinity(막지 않는다). */
export async function remaining() {
  try {
    const { usage, quota } = await navigator.storage.estimate();
    if (!Number.isFinite(usage) || !Number.isFinite(quota)) return Infinity;
    return Math.max(0, quota - usage);
  } catch {
    return Infinity;
  }
}

async function dir(parent, name, create) {
  try {
    return await parent.getDirectoryHandle(name, { create });
  } catch {
    return null;
  }
}

async function readFileIn(parent, name) {
  const handle = await parent.getFileHandle(name);
  const file = await handle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

async function writeFileIn(parent, name, bytes) {
  const handle = await parent.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close(); // 여기서야 파일이 자리를 잡는다(원자적)
}

/**
 * 한 영상의 저장소. 트랙(itag)별 조각 통과 완성본 자리를 준다.
 *
 * 열 때 시각 도장을 찍어 둔다 — cleanup 이 "요즘 쓴 것"을 알아보는 근거다.
 */
export async function openDisk(videoId) {
  const opfs = await navigator.storage.getDirectory();
  const root = await dir(opfs, ROOT, true);
  const home = await dir(root, videoId, true);
  await writeFileIn(home, STAMP, new TextEncoder().encode(String(Date.now())));

  return {
    kind: "disk",

    /** 트랙 하나의 조각 통. 이름 → 바이트. */
    async track(itag) {
      const box = await dir(home, String(itag), true);
      // 있는 조각 이름을 한 번에 읽어 둔다. 조각이 수백 개라도 목록은 값싸다.
      const names = new Set();
      for await (const name of box.keys()) names.add(name);
      return {
        has: (name) => names.has(name),
        read: (name) => readFileIn(box, name),
        async write(name, bytes) {
          await writeFileIn(box, name, bytes);
          names.add(name);
        },
      };
    },

    /** 완성본을 흘려 쓸 자리. close() 가 디스크 기반 File 을 돌려준다(메모리에 안 올라온다). */
    async output() {
      const handle = await home.getFileHandle("out.mp4", { create: true });
      const writable = await handle.createWritable(); // 기존 내용은 지워진다
      return {
        write: (bytes) => writable.write(bytes),
        async close() {
          await writable.close();
          return handle.getFile();
        },
        abort: () => writable.abort().catch(() => {}),
      };
    },

    /** 저장까지 끝났으면 조각은 더 필요 없다. 완성본(out.mp4)은 브라우저가 아직
     *  내려받기로 옮기는 중일 수 있어 여기서 지우지 않는다 — cleanup 몫이다. */
    async clearChunks() {
      for await (const [name, handle] of home.entries()) {
        if (handle.kind === "directory") {
          await home.removeEntry(name, { recursive: true }).catch(() => {});
        }
      }
    },
  };
}

/** 이어받을 것이 남아 있는지(조각이 하나라도 있는지). 알림 문구를 고르는 데만 쓴다. */
export async function hasLeftovers(videoId) {
  try {
    const opfs = await navigator.storage.getDirectory();
    const root = await dir(opfs, ROOT, false);
    const home = root && (await dir(root, videoId, false));
    if (!home) return false;
    for await (const [, handle] of home.entries()) {
      if (handle.kind === "directory") return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** 이 영상의 저장소를 통째로 지운다(받다 만 조각 버리기). */
export async function discard(videoId) {
  try {
    const opfs = await navigator.storage.getDirectory();
    const root = await dir(opfs, ROOT, false);
    await root?.removeEntry(videoId, { recursive: true });
  } catch {
    // 지울 것이 없거나 디스크가 없는 곳이면 그대로 둔다
  }
}

/** 오래 안 쓴 영상 폴더를 지운다. 그만둔 이어받기와 완성본 찌꺼기가 디스크에 눌러앉지 않게. */
export async function cleanup(maxAgeMs = 2 * 24 * 3600 * 1000) {
  try {
    const opfs = await navigator.storage.getDirectory();
    const root = await dir(opfs, ROOT, false);
    if (!root) return;
    const now = Date.now();
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== "directory") continue;
      let stamped = 0;
      try {
        const bytes = await readFileIn(handle, STAMP);
        stamped = Number(new TextDecoder().decode(bytes)) || 0;
      } catch {
        // 도장이 없으면 옛 것으로 본다
      }
      if (now - stamped >= maxAgeMs) {
        await root.removeEntry(name, { recursive: true }).catch(() => {});
      }
    }
  } catch {
    // 청소는 못 해도 받는 일은 계속돼야 한다
  }
}

/**
 * OPFS 가 없을 때의 대체 저장소. 모양은 같고 자리만 메모리다.
 * 이어받기는 안 되지만(탭이 죽으면 함께 사라진다) 받는 일 자체는 그대로 된다.
 * 시험(deno)에서도 이것을 쓴다.
 */
export function openMemory() {
  const tracks = new Map();
  return {
    kind: "memory",
    async track(itag) {
      if (!tracks.has(itag)) tracks.set(itag, new Map());
      const box = tracks.get(itag);
      return {
        has: (name) => box.has(name),
        read: async (name) => box.get(name),
        write: async (name, bytes) => {
          box.set(name, bytes);
        },
      };
    },
    async output() {
      const parts = [];
      return {
        write: async (bytes) => {
          parts.push(bytes);
        },
        close: async () => new Blob(parts, { type: "video/mp4" }),
        abort: () => {},
      };
    },
    async clearChunks() {
      tracks.clear();
    },
  };
}

/** 쓸 수 있는 가장 좋은 저장소를 연다. */
export async function openBest(videoId) {
  if (await diskAvailable()) {
    try {
      return await openDisk(videoId);
    } catch {
      // 디스크가 갑자기 안 열려도 받는 일은 계속돼야 한다
    }
  }
  return openMemory();
}
