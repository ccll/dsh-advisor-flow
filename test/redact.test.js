import test from 'node:test';
import assert from 'node:assert/strict';
import { redactText, REDACTED, redactAndCapText } from '../lib/redact.js';

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

test('R-02-004/AC-04 先脱敏后截断：截断边界不得残留密钥片段（redactAndCapText）', () => {
    // 构造密钥横跨截断边界的素材：先截断会把密钥切成低于形状阈值的残片泄漏
    const prefix = 'x'.repeat(60);
    const secret = 'sk-Abc12345_-XYZ98765';
    const text = `${prefix} ${secret} ${'y'.repeat(200)}`;
    const out = redactAndCapText(text, 80);
    assert.doesNotMatch(out, /sk-[A-Za-z0-9_-]{4,}/);
});
