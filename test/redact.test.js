import test from 'node:test';
import assert from 'node:assert/strict';
import { redactText, REDACTED } from '../lib/redact.js';

test('R-02-004/AC-03 脱敏开启时密钥形状值被占位替换', () => {
    const out = redactText([
        'key: sk-Abc12345_-XYZ98765',
        'short-sk not-a-key-sk-1',
        'Authorization: Bearer eyJhbGciOi.payload.sig',
        'aws: AKIA1234567890ABCDEF',
        'password=hunter2',
        'token: "abc123"',
        'api_key = s3cr3t-value',
        'api-key: v',
    ].join('\n'));
    assert.ok(!out.includes('sk-Abc12345_-XYZ98765'));
    assert.ok(out.includes(REDACTED));
    // 短于形状下界的 sk- 前缀不算密钥
    assert.ok(out.includes('not-a-key-sk-1'));
    assert.ok(!out.includes('eyJhbGciOi'));
    assert.ok(out.match(/Bearer\s+\[REDACTED\]/));
    assert.ok(!out.includes('AKIA1234567890ABCDEF'));
    assert.ok(out.includes('password=[REDACTED]'));
    assert.ok(out.includes('token: [REDACTED]'));
    assert.ok(out.includes('api_key = [REDACTED]'));
    assert.ok(out.includes('api-key: [REDACTED]'));
    // 键名保留，仅值被替换
    assert.ok(out.includes('password='));
});

test('R-02-004/AC-03 脱敏可关闭：关闭时原样返回', () => {
    const material = 'token: abc123 sk-Abc12345_-XYZ98765';
    assert.equal(redactText(material, { enabled: false }), material);
});
