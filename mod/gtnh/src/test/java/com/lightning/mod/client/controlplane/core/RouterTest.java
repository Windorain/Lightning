package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import java.util.concurrent.atomic.AtomicReference;

import org.junit.Before;
import org.junit.Test;

import com.google.gson.JsonObject;

/**
 * {@link Router} 单测：信封形状、鉴权/权限级、confirm、错误码 → HTTP 状态码映射、路径匹配与拒绝留痕。
 */
public class RouterTest {

    private static final String OBSERVE = "observe-token";
    private static final String SCENE = "scene-token";
    private static final String FORENSIC = "forensic-token";

    private Router router;
    private ActionRegistry actions;
    private EventStream events;

    private static ActionDescriptor ping() {
        return ActionDescriptor.builder("core.ping", Tier.OBSERVE)
            .description("存活回声")
            .optional("echo", ActionDescriptor.TYPE_STRING, "原样回显")
            .returns("{pong:true}")
            .example("{\"echo\":\"hi\"}")
            .since("1.0")
            .build();
    }

    private static ActionDescriptor rebuild() {
        return ActionDescriptor.builder("world.rebuild", Tier.SCENE)
            .description("幂等重建托管世界")
            .optional("scenario", ActionDescriptor.TYPE_ARRAY, "场景构建段")
            .returns("{world:{...}}")
            .build();
    }

    @Before
    public void setUp() {
        events = new EventStream(64, null, null);
        router = new Router(new TokenStore(OBSERVE, SCENE, FORENSIC), events, null);
        actions = new ActionRegistry();
        actions.register(ping(), new ControlAction() {

            @Override
            public JsonObject execute(ActionContext ctx) {
                JsonObject o = new JsonObject();
                o.addProperty("pong", true);
                return o;
            }
        });
        actions.register(rebuild(), new ControlAction() {

            @Override
            public JsonObject execute(ActionContext ctx) {
                JsonObject o = new JsonObject();
                o.addProperty("rebuilt", true);
                return o;
            }
        });

        router.get(Contract.PREFIX + "/actions", Tier.OBSERVE, new Router.Handler() {

            @Override
            public Router.Result handle(Router.Request req) {
                return Router.Result.ok(actions.describeAll());
            }
        });
        router.postAction(Contract.PREFIX + "/actions/{name}", actions, new Router.Handler() {

            @Override
            public Router.Result handle(Router.Request req) {
                String name = req.pathParam("name");
                if (actions.descriptor(name) == null) {
                    throw CpException.unknown("动作 " + name);
                }
                JsonObject o = new JsonObject();
                o.addProperty("accepted", name);
                return Router.Result.ok(202, o);
            }
        });
        router.get(Contract.PREFIX + "/jobs/{id}", Tier.OBSERVE, new Router.Handler() {

            @Override
            public Router.Result handle(Router.Request req) {
                JsonObject o = new JsonObject();
                o.addProperty("jobId", req.pathParam("id"));
                return Router.Result.ok(o);
            }
        });
        router.get(Contract.PREFIX + "/artifacts/{runId}/{path...}", Tier.OBSERVE, new Router.Handler() {

            @Override
            public Router.Result handle(Router.Request req) {
                JsonObject o = new JsonObject();
                o.addProperty("runId", req.pathParam("runId"));
                o.addProperty("path", req.pathParam("path"));
                return Router.Result.ok(o);
            }
        });
        router.get(Contract.PREFIX + "/boom", Tier.OBSERVE, new Router.Handler() {

            @Override
            public Router.Result handle(Router.Request req) {
                throw new CpException(ErrorCodes.STATE, "世界未加载");
            }
        });
        router.get(Contract.PREFIX + "/crash", Tier.OBSERVE, new Router.Handler() {

            @Override
            public Router.Result handle(Router.Request req) {
                throw new IllegalStateException("boom");
            }
        });
    }

    private Router.Result call(String method, String path, String token, String body) {
        return router.handle(
            Router.Request.builder()
                .method(method)
                .path(path)
                .token(token)
                .body(body)
                .build());
    }

    private static JsonObject dataOf(Router.Result r) {
        assertTrue("应当是 JSON 响应", r.isJson());
        assertTrue("应当是成功信封: " + Json.toJson(r.envelope()), Envelope.isOk(r.envelope()));
        return Envelope.data(r.envelope())
            .getAsJsonObject();
    }

    @Test
    public void successEnvelopeIsOkTrueWithData() {
        Router.Result r = call("GET", Contract.PREFIX + "/actions", OBSERVE, null);
        assertEquals(200, r.status());
        JsonObject envelope = r.envelope()
            .getAsJsonObject();
        assertTrue(
            envelope.get("ok")
                .getAsBoolean());
        assertTrue(envelope.has("data"));
        assertFalse(envelope.has("error"));
        assertEquals(
            2,
            envelope.getAsJsonObject("data")
                .get("count")
                .getAsInt());
    }

    @Test
    public void unknownEndpointIs404ValidUnknown() {
        Router.Result r = call("GET", Contract.PREFIX + "/nope", OBSERVE, null);
        assertEquals(404, r.status());
        assertEquals(ErrorCodes.VALID_UNKNOWN, Envelope.errorCode(r.envelope()));
    }

    @Test
    public void wrongMethodIs405() {
        Router.Result r = call("POST", Contract.PREFIX + "/actions", OBSERVE, "{}");
        assertEquals(405, r.status());
        assertEquals(ErrorCodes.VALID_UNKNOWN, Envelope.errorCode(r.envelope()));
    }

    @Test
    public void missingOrWrongTokenIs401AndIsLoggedAsReject() {
        for (String token : new String[] { null, "", "wrong" }) {
            Router.Result r = call("GET", Contract.PREFIX + "/actions", token, null);
            assertEquals(401, r.status());
            assertEquals(ErrorCodes.AUTH_MISSING, Envelope.errorCode(r.envelope()));
        }
        assertTrue(events.countKind(EventStream.Kinds.ACTION_REJECT) >= 3);
    }

    @Test
    public void tokenFromQueryIsItselfNotUsedByRouterButBearerEquivalentAccepted() {
        // Router 不解析查询串，token 由服务层提取后放进 Request；这里验证错误的 token 一定被拒
        Router.Result r = call("GET", Contract.PREFIX + "/actions", OBSERVE + "x", null);
        assertEquals(401, r.status());
    }

    @Test
    public void insufficientTierIs403WithContext() {
        Router.Result r = call("POST", Contract.PREFIX + "/actions/world.rebuild", OBSERVE, "{\"confirm\":true}");
        assertEquals(403, r.status());
        JsonObject error = r.envelope()
            .getAsJsonObject()
            .getAsJsonObject("error");
        assertEquals(
            ErrorCodes.AUTH_INSUFFICIENT,
            error.get("code")
                .getAsString());
        assertEquals(
            "scene",
            error.getAsJsonObject("context")
                .get("required")
                .getAsString());
        assertEquals(
            "observe",
            error.getAsJsonObject("context")
                .get("actual")
                .getAsString());
    }

    @Test
    public void writableActionWithoutConfirmIs400ConfirmRequired() {
        Router.Result r = call("POST", Contract.PREFIX + "/actions/world.rebuild", SCENE, "{}");
        assertEquals(400, r.status());
        assertEquals(ErrorCodes.CONFIRM_REQUIRED, Envelope.errorCode(r.envelope()));
        // 无请求体同样必须被拒
        Router.Result noBody = call("POST", Contract.PREFIX + "/actions/world.rebuild", SCENE, null);
        assertEquals(400, noBody.status());
        assertEquals(ErrorCodes.CONFIRM_REQUIRED, Envelope.errorCode(noBody.envelope()));
        // confirm 为字符串 "true" 不算确认
        Router.Result wrongType = call(
            "POST",
            Contract.PREFIX + "/actions/world.rebuild",
            SCENE,
            "{\"confirm\":\"true\"}");
        assertEquals(400, wrongType.status());
    }

    @Test
    public void higherTierTokenCoversLowerRequirement() {
        Router.Result r = call("POST", Contract.PREFIX + "/actions/world.rebuild", FORENSIC, "{\"confirm\":true}");
        assertEquals(202, r.status());
        assertEquals(
            "world.rebuild",
            dataOf(r).get("accepted")
                .getAsString());
    }

    @Test
    public void observeActionNeedsNoConfirm() {
        Router.Result r = call("POST", Contract.PREFIX + "/actions/core.ping", OBSERVE, "{}");
        assertEquals(202, r.status());
        assertEquals(
            "core.ping",
            dataOf(r).get("accepted")
                .getAsString());
    }

    @Test
    public void unknownActionIs404AndRequiresAuthenticationFirst() {
        Router.Result withToken = call("POST", Contract.PREFIX + "/actions/no.such", OBSERVE, "{}");
        assertEquals(404, withToken.status());
        assertEquals(ErrorCodes.VALID_UNKNOWN, Envelope.errorCode(withToken.envelope()));

        // 未认证 + 未知动作：先报 401，不泄漏动作是否存在
        Router.Result noToken = call("POST", Contract.PREFIX + "/actions/no.such", null, "{}");
        assertEquals(401, noToken.status());
    }

    @Test
    public void malformedBodyIs400ValidParamWithFieldDetail() {
        Router.Result r = call("POST", Contract.PREFIX + "/actions/core.ping", OBSERVE, "{oops}");
        assertEquals(400, r.status());
        JsonObject error = r.envelope()
            .getAsJsonObject()
            .getAsJsonObject("error");
        assertEquals(
            ErrorCodes.VALID_PARAM,
            error.get("code")
                .getAsString());
        assertEquals(
            "body",
            error.getAsJsonObject("context")
                .getAsJsonArray("fields")
                .get(0)
                .getAsJsonObject()
                .get("field")
                .getAsString());
    }

    @Test
    public void nonObjectBodyIsRejected() {
        Router.Result r = call("POST", Contract.PREFIX + "/actions/core.ping", OBSERVE, "[1,2,3]");
        assertEquals(400, r.status());
        assertEquals(ErrorCodes.VALID_PARAM, Envelope.errorCode(r.envelope()));
    }

    @Test
    public void handlerCpExceptionMapsCodeAndHttpStatus() {
        Router.Result r = call("GET", Contract.PREFIX + "/boom", OBSERVE, null);
        assertEquals(409, r.status());
        assertEquals(ErrorCodes.STATE, Envelope.errorCode(r.envelope()));
        assertEquals(
            "世界未加载",
            r.envelope()
                .getAsJsonObject()
                .getAsJsonObject("error")
                .get("message")
                .getAsString());
    }

    @Test
    public void unexpectedHandlerExceptionBecomes500ExecFailed() {
        Router.Result r = call("GET", Contract.PREFIX + "/crash", OBSERVE, null);
        assertEquals(500, r.status());
        assertEquals(ErrorCodes.EXEC_FAILED, Envelope.errorCode(r.envelope()));
    }

    @Test
    public void pathParamsAndCatchAllSegmentsAreCapturedAndDecoded() {
        Router.Result job = call("GET", Contract.PREFIX + "/jobs/j7", OBSERVE, null);
        assertEquals(
            "j7",
            dataOf(job).get("jobId")
                .getAsString());

        Router.Result artifact = call(
            "GET",
            Contract.PREFIX + "/artifacts/20261006-120000-c-1/world/scene%20manifest.json",
            OBSERVE,
            null);
        JsonObject d = dataOf(artifact);
        assertEquals(
            "20261006-120000-c-1",
            d.get("runId")
                .getAsString());
        assertEquals(
            "world/scene manifest.json",
            d.get("path")
                .getAsString());
    }

    @Test
    public void catchAllDoesNotMatchEmptyTail() {
        Router.Result r = call("GET", Contract.PREFIX + "/artifacts/run1", OBSERVE, null);
        assertEquals(404, r.status());
    }

    @Test
    public void errorEnvelopeCarriesCodeMessageAndOptionalContext() {
        Router.Result r = call("GET", Contract.PREFIX + "/boom", OBSERVE, null);
        JsonObject envelope = r.envelope()
            .getAsJsonObject();
        assertFalse(
            envelope.get("ok")
                .getAsBoolean());
        JsonObject error = envelope.getAsJsonObject("error");
        assertNotNull(error.get("code"));
        assertNotNull(error.get("message"));
        assertEquals(
            ErrorCodes.STATE,
            error.get("code")
                .getAsString());
    }

    @Test
    public void requestQueryHelpers() {
        Router.Request req = Router.Request.builder()
            .path("/x")
            .query("sync", "true")
            .query("timeoutMs", "1500")
            .query("junk", "abc")
            .build();
        assertTrue(req.queryBool("sync", false));
        assertFalse(req.queryBool("missing", false));
        assertEquals(1500L, req.queryLong("timeoutMs", 0L));
        assertEquals(7L, req.queryLong("junk", 7L));
        assertEquals("abc", req.query("junk"));
    }

    @Test
    public void percentDecodeKeepsPlusLiteral() {
        assertEquals("a+b", Router.percentDecode("a+b"));
        assertEquals("a b", Router.percentDecode("a%20b"));
        assertEquals("中文", Router.percentDecode("%E4%B8%AD%E6%96%87"));
    }

    @Test
    public void contentTypeMapping() {
        assertEquals("application/json; charset=utf-8", Router.contentTypeOf("manifest.json"));
        assertEquals("image/png", Router.contentTypeOf("a/b.png"));
        assertEquals("application/octet-stream", Router.contentTypeOf("blob.bin"));
    }

    @Test
    public void handlerIsNotInvokedWhenAuthorizationFails() {
        final AtomicReference<Boolean> called = new AtomicReference<Boolean>(Boolean.FALSE);
        Router r2 = new Router(new TokenStore(OBSERVE, SCENE, FORENSIC), events, null);
        r2.get("/cp/v1/secret", Tier.FORENSIC, new Router.Handler() {

            @Override
            public Router.Result handle(Router.Request req) {
                called.set(Boolean.TRUE);
                return Router.Result.ok(new JsonObject());
            }
        });
        Router.Result res = r2.handle(
            Router.Request.builder()
                .method("GET")
                .path("/cp/v1/secret")
                .token(SCENE)
                .build());
        assertEquals(403, res.status());
        assertFalse(called.get());
    }
}
