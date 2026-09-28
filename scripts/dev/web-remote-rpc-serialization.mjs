// @zcode/rpc Layer-1 序列化（[1B 类型][VQL 长度][数据]）的夹具实现。
// 与 packages/rpc/src/serialization.ts 同口径；回环终端要靠它构造真正的请求/应答报文。

const RPC_TAG = { undefined: 0, string: 1, buffer: 2, vsBuffer: 3, array: 4, object: 5, int: 6 };

export const RpcResponseType = {
  Initialize: 200,
  PromiseSuccess: 201,
  PromiseError: 202,
  PromiseErrorObj: 203,
  EventFire: 204,
};

function vqlOf(value) {
  const out = [];
  if (value === 0) {
    out.push(0);
    return out;
  }
  let rest = value;
  while (rest !== 0) {
    let byte = rest & 0b0111_1111;
    rest >>>= 7;
    if (rest > 0) byte |= 0b1000_0000;
    out.push(byte);
  }
  return out;
}

function serializeInto(out, value) {
  if (value === undefined) {
    out.push(RPC_TAG.undefined);
    return;
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    out.push(RPC_TAG.string, ...vqlOf(bytes.byteLength), ...bytes);
    return;
  }
  if (Array.isArray(value)) {
    out.push(RPC_TAG.array, ...vqlOf(value.length));
    for (const item of value) serializeInto(out, item);
    return;
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    out.push(RPC_TAG.int, ...vqlOf(value));
    return;
  }
  const json = Buffer.from(JSON.stringify(value), "utf8");
  out.push(RPC_TAG.object, ...vqlOf(json.byteLength), ...json);
}

/** 组一条 RPC 报文：serialize(header) + serialize(body)。 */
export function serializeRpcMessage(header, body) {
  const out = [];
  serializeInto(out, header);
  serializeInto(out, body);
  return Buffer.from(out);
}

/** 拆一条 RPC 报文，返回 {header, body}。 */
export function deserializeRpcMessage(buffer) {
  const bytes = Buffer.from(buffer);
  let pos = 0;
  const readVql = () => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = bytes[pos];
      pos += 1;
      value |= (byte & 0b0111_1111) << shift;
      if (!(byte & 0b1000_0000)) return value;
    }
  };
  const readValue = () => {
    const tag = bytes[pos];
    pos += 1;
    switch (tag) {
      case RPC_TAG.undefined:
        return undefined;
      case RPC_TAG.string: {
        const length = readVql();
        const text = bytes.subarray(pos, pos + length).toString("utf8");
        pos += length;
        return text;
      }
      case RPC_TAG.buffer:
      case RPC_TAG.vsBuffer: {
        const length = readVql();
        const slice = bytes.subarray(pos, pos + length);
        pos += length;
        return new Uint8Array(slice);
      }
      case RPC_TAG.array: {
        const length = readVql();
        const items = [];
        for (let index = 0; index < length; index += 1) items.push(readValue());
        return items;
      }
      case RPC_TAG.object: {
        const length = readVql();
        const text = bytes.subarray(pos, pos + length).toString("utf8");
        pos += length;
        return JSON.parse(text);
      }
      case RPC_TAG.int:
        return readVql();
      default:
        throw new Error(`未知序列化标签 ${tag} @${pos - 1}`);
    }
  };
  const header = readValue();
  const body = pos < bytes.byteLength ? readValue() : undefined;
  return { header, body };
}
