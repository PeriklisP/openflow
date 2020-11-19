import * as RED from "node-red";
import { Red } from "node-red";
import { Logger } from "../../Logger";
import { Config } from "../../Config";
import { WebSocketClient, NoderedUtil, Base, Role, Rolemember, QueueMessage } from "openflow-api";

export interface Iworkflow_in_node {
    queue: string;
    name: string;
    rpa: boolean;
    web: boolean;
}
export class workflow_in_node {
    public node: Red = null;
    public name: string = "";
    public host: string = null;
    public workflow: any;
    public localqueue: string = "";
    private _onsignedin: any = null;
    private _onsocketclose: any = null;
    constructor(public config: Iworkflow_in_node) {
        RED.nodes.createNode(this, config);
        try {
            this.node = this;
            this.node.on("close", this.onclose);
            this.host = Config.amqp_url;
            this._onsignedin = this.onsignedin.bind(this);
            this._onsocketclose = this.onsocketclose.bind(this);
            WebSocketClient.instance.events.on("onsignedin", this._onsignedin);
            WebSocketClient.instance.events.on("onclose", this._onsocketclose);
            if (WebSocketClient.instance.isConnected && WebSocketClient.instance.user != null) {
                this.connect();
            }
        } catch (error) {
            NoderedUtil.HandleError(this, error);
        }
    }
    onsignedin() {
        this.connect();
    }
    onsocketclose(message) {
        if (message == null) message = "";
        if (this.node != null) this.node.status({ fill: "red", shape: "dot", text: "Disconnected " + message });
        // this.onclose(false, null);
    }
    async connect() {
        try {
            Logger.instanse.info("track::workflow in::connect");
            if (this.config.queue == null || this.config.queue == "") {
                this.node.status({ fill: "red", shape: "dot", text: "Missing queue name" });
                return;
            }
            this.node.status({ fill: "blue", shape: "dot", text: "Connecting..." });
            // if (this.localqueue !== null && this.localqueue !== undefined && this.localqueue !== "") { this.localqueue = Config.queue_prefix + this.localqueue; }
            this.localqueue = this.config.queue;
            this.localqueue = await NoderedUtil.RegisterQueue(WebSocketClient.instance, this.localqueue, (msg: QueueMessage, ack: any) => {
                this.OnMessage(msg, ack);
            });
            await this.init();
            this.node.status({ fill: "green", shape: "dot", text: "Connected " + this.localqueue });
        } catch (error) {
            NoderedUtil.HandleError(this, error);
        }
    }
    async init() {
        let name = this.config.name;

        Logger.instanse.info("track::workflow in::init");
        if (NoderedUtil.IsNullEmpty(name)) {
            name = this.config.queue;
        }

        const res = await NoderedUtil.Query("workflow", { "queue": this.localqueue }, null, null, 1, 0, null);
        if (res.length == 0) {
            const noderedadmins = await NoderedUtil.GetRole(null, Config.noderedadmins);
            let wf: Base = new Base();
            wf._type = "workflow";
            wf.name = name;
            (wf as any).queue = this.localqueue;
            if (noderedadmins != null) {
                Base.addRight(wf, noderedadmins._id, noderedadmins.name, [-1]);
            }
            this.workflow = await NoderedUtil.InsertOne("workflow", { _type: "workflow", "queue": this.localqueue, "name": name }, 0, false, null);
        } else {
            this.workflow = res[0];
            const hasnoderedadmins = this.workflow._acl.filter(x => x.name == Config.noderedadmins);
            if (hasnoderedadmins.length == 0) {
                const noderedadmins = await NoderedUtil.GetRole(null, Config.noderedadmins);
                if (noderedadmins != null) {
                    Base.addRight(this.workflow, noderedadmins._id, noderedadmins.name, [-1]);
                }
            }
        }
        const res2 = await NoderedUtil.Query("users", { "_type": "role", "$or": [{ "workflowid": this.workflow._id }, { "name": this.localqueue + "users" }] }, null, null, 1, 0, null);
        let role: Base = null;
        if (res2.length == 0) {
            const who = WebSocketClient.instance.user;
            (role as any) = { _type: "role", "name": this.localqueue + "users", members: [{ "_id": who._id, "name": who.name }], "workflowid": this.workflow._id };
            role = await NoderedUtil.InsertOne("users", role, 0, false, null);
        } else {
            role = res2[0];
        }
        Base.addRight(this.workflow, role._id, role.name, [-1]);
        this.workflow.queue = this.localqueue;
        this.workflow.name = name;
        this.workflow.rpa = this.config.rpa;
        this.workflow.web = this.config.web;
        this.workflow = await NoderedUtil.UpdateOne("workflow", null, this.workflow, 0, false, null);
    }
    nestedassign(target, source) {
        if (source === null || source === undefined) return null;
        const keys = Object.keys(source);
        for (let i = 0; i < keys.length; i++) {
            try {
                const sourcekey = keys[i];
                if (Object.keys(source).find(targetkey => targetkey === sourcekey) !== undefined &&
                    Object.keys(source).find(targetkey => targetkey === sourcekey) !== null
                    && typeof source === "object" && typeof source[sourcekey] === "object") {
                    if (target[sourcekey] === undefined || target[sourcekey] === null) {
                        // target[sourcekey] = {};
                    } else {
                        target[sourcekey] = this.nestedassign(target[sourcekey], source[sourcekey]);
                    }
                } else {
                    target[sourcekey] = source[sourcekey];
                }
            } catch (error) {
                if (target != null && target != undefined) Logger.instanse.info(JSON.stringify(target));
                if (source != null && source != undefined) Logger.instanse.info(JSON.stringify(source));
                Logger.instanse.error(error);
            }
        }
        return target;
    }
    async OnMessage(msg: QueueMessage, ack: any) {
        try {
            this.node.status({ fill: "blue", shape: "dot", text: "Processing" });
            let data: any = msg;
            data.payload = msg.data;
            delete data.data;
            try {
                data.payload = JSON.parse(data.payload);
            } catch (error) {
            }
            if (data.payload != null && data.payload.__jwt != null && data.__jwt == null) {
                if (!NoderedUtil.IsNullUndefinded(data.payload.__user)) {
                    data.user = data.payload.__user;
                    delete data.payload.__user;
                }
                data.jwt = data.payload.__jwt;
                delete data.payload.__jwt;
            }
            while (data.payload != null && data.payload.payload != null) {
                data.payload = data.payload.payload;
            }
            // if (data.payload != null && data.payload.payload != null) {
            //     // UGLy ROLLBACK!
            //     data.payload = data.payload.payload;
            // }
            let _id = data._id;
            if (_id === null || _id === undefined || _id === "") {
                if (data.payload !== null && data.payload !== undefined) {
                    if (data.payload._id !== null && data.payload._id !== undefined && data.payload._id !== "") {
                        _id = data.payload._id;
                    }
                }
            }
            if (_id !== null && _id !== undefined && _id !== "") {
                this.node.status({ fill: "blue", shape: "dot", text: "Processing id " + _id });
                const jwt = data.jwt;
                delete data.jwt;

                const res = await NoderedUtil.Query("workflow_instances", { "_id": _id }, null, null, 1, 0, jwt);
                if (res.length == 0) {
                    NoderedUtil.HandleError(this, "Unknown workflow_instances id " + _id);
                    if (ack !== null && ack !== undefined) ack(false, "Unknown workflow_instances id " + _id);
                    return;
                }
                const orgmsg = res[0];
                if (orgmsg.payload === null || orgmsg.payload === undefined) {
                    orgmsg.payload = data;
                    data = orgmsg;
                } else {
                    if (typeof orgmsg.payload === "object") {
                        orgmsg.payload = Object.assign(orgmsg.payload, data.payload);
                    } else {
                        orgmsg.payload = { message: orgmsg.payload };
                        orgmsg.payload = Object.assign(orgmsg.payload, data.payload);
                    }
                    orgmsg.jwt = data.jwt;
                    orgmsg.user = data.user;
                    data = orgmsg;
                }
                data.jwt = jwt;
            } else {
                this.node.status({ fill: "blue", shape: "dot", text: "Processing new instance " });
                const jwt = data.jwt;

                let who = WebSocketClient.instance.user;
                const me = WebSocketClient.instance.user;
                this.node.status({ fill: "blue", shape: "dot", text: "Renew token " });
                if (!NoderedUtil.IsNullEmpty(jwt)) {
                    const signin = await NoderedUtil.RenewToken(jwt, true);
                    who = signin.user;
                    data.jwt = signin.jwt;
                }
                // delete data.jwt;                
                const item: Base = ({ _type: "instance", "queue": this.localqueue, "name": this.workflow.name, payload: data, workflow: this.workflow._id, targetid: who._id }) as any;
                (item as any)._replyTo = msg.replyto;
                (item as any)._correlationId = msg.correlationId;
                Base.addRight(item, who._id, who.name, [-1]);
                if (who._id != me._id) Base.addRight(item, me._id, me.name, [-1]);
                this.node.status({ fill: "blue", shape: "dot", text: "Create instance " });
                const res2 = await NoderedUtil.InsertOne("workflow_instances", item, 1, true, jwt);

                // Logger.instanse.info("workflow in activated creating a new workflow instance with id " + res2._id);
                // OpenFlow Controller.ts needs the id, when creating a new intance !
                data._id = res2._id;
                this.node.status({ fill: "blue", shape: "dot", text: "Processing new id " + res2._id });
                if (data.payload !== null && data.payload != undefined) {
                    try {
                        data.payload._id = res2._id;
                    } catch (error) {
                        Logger.instanse.warn(error);
                    }
                }
                // result = this.nestedassign(res2, result);
                data = Object.assign(res2, data);
                data.jwt = jwt;
            }
            data.amqpacknowledgment = ack;
            data._replyTo = msg.replyto;
            data._correlationId = msg.correlationId;

            if (data != null && data.jwt != null && data.payload != null && data.jwt == data.payload.jwt) {
                delete data.payload.jwt;
            }

            this.node.send(data);
            // this.node.send(result);
            this.node.status({ fill: "green", shape: "dot", text: "Connected " + this.localqueue });
        } catch (error) {
            NoderedUtil.HandleError(this, error);
            try {

                const data: any = {};
                data.error = error;
                data.payload = msg.data;
                data.jwt = msg.jwt;
                if (data.payload === null || data.payload === undefined) {
                    data.payload = {};
                }
                ack(false, JSON.stringify(data));
            } catch (error) {
                Logger.instanse.error(error);
            }
        }
    }
    async onclose(removed: boolean, done: any) {
        try {
            if (removed && Config.workflow_node_auto_cleanup) {
                let res = await NoderedUtil.Query("workflow", { "queue": this.localqueue }, null, null, 1, 0, null);
                if (res.length > 0) {
                    await NoderedUtil.DeleteOne("workflow", res[0]._id, null);
                }
                if (this.workflow != null) {
                    res = await NoderedUtil.Query("users", { "_type": "role", "$or": [{ "workflowid": this.workflow._id }, { "name": this.localqueue + "users" }] }, null, null, 1, 0, null);
                }
                if (res.length > 0) {
                    await NoderedUtil.DeleteOne("users", res[0]._id, null);
                }
            }
            if (!NoderedUtil.IsNullEmpty(this.localqueue) && removed) {
                NoderedUtil.CloseQueue(WebSocketClient.instance, this.localqueue);
                this.localqueue = "";
            }
        } catch (error) {
            Logger.instanse.error(error);
            NoderedUtil.HandleError(this, error);
        }
        WebSocketClient.instance.events.removeListener("onsignedin", this._onsignedin);
        WebSocketClient.instance.events.removeListener("onclose", this._onsocketclose);
        if (done != null) done();
    }
}



export interface Iworkflow_out_node {
    state: string;
    form: string;
    removestate: boolean;
}
export class workflow_out_node {
    public node: Red = null;
    public name: string = "";
    public host: string = "";
    constructor(public config: Iworkflow_out_node) {
        RED.nodes.createNode(this, config);
        this.node = this;
        this.host = Config.amqp_url;
        this.node.status({});
        this.node.on("input", this.oninput);
        this.node.on("close", this.onclose);
    }
    async oninput(msg: any) {
        try {
            this.node.status({});
            msg.state = this.config.state;
            msg.form = this.config.form;
            if (msg._id !== null && msg._id !== undefined && msg._id !== "") {
                if (this.config.removestate) {
                    let msgcopy: any = {};
                    msgcopy._id = msg._id;
                    msgcopy.queue = msg.queue;
                    msgcopy.name = msg.name;
                    msgcopy.workflow = msg.workflow;
                    msgcopy.targetid = msg.targetid;
                    msgcopy.replyto = msg.replyto;
                    msgcopy.correlationId = msg.correlationId;
                    msgcopy.queuename = msg.queuename;
                    msgcopy.consumerTag = msg.consumerTag;
                    msgcopy.exchange = msg.exchange;
                    msgcopy._msgid = msg._msgid;
                    msgcopy.state = msg.state;
                    msgcopy.form = msg.form;
                    this.node.status({ fill: "blue", shape: "dot", text: "Updating workflow instance" });
                    await NoderedUtil.UpdateOne("workflow_instances", null, msgcopy, 1, false, msg.jwt);
                } else {
                    let msgcopy = Object.assign({}, msg);
                    delete msgcopy.jwt;
                    delete msgcopy.user;
                    // Logger.instanse.info("Updating workflow instance with id " + msg._id + " (" + msg.name + " with state " + msg.state);
                    this.node.status({ fill: "blue", shape: "dot", text: "Updating workflow instance" });
                    await NoderedUtil.UpdateOne("workflow_instances", null, msgcopy, 1, false, msg.jwt);
                }
            }
        } catch (error) {
            NoderedUtil.HandleError(this, error);
        }
        try {
            if (msg.amqpacknowledgment) {
                this.node.status({ fill: "blue", shape: "dot", text: "amqpacknowledgment" });
                msg.amqpacknowledgment(true);
            }
        } catch (error) {
            NoderedUtil.HandleError(this, error);
            return;
        }
        try {
            if (!NoderedUtil.IsNullEmpty(msg.resultqueue) && (msg.state == "completed" || msg.state == "failed")) {
                const data: any = {};
                data.state = msg.state;
                if (msg.error) {
                    data.error = "error";
                    if (msg.error.message) {
                        data.error = msg.error.message;
                    }
                }
                data._id = msg._id;
                data.payload = msg.payload;
                data.values = msg.values;
                data.jwt = msg.jwt;
                const expiration: number = (typeof msg.expiration == 'number' ? msg.expiration : Config.amqp_workflow_out_expiration);
                this.node.status({ fill: "blue", shape: "dot", text: "QueueMessage.1" });
                await NoderedUtil.QueueMessage(WebSocketClient.instance, msg.resultqueue, null, data, msg.correlationId, expiration);
                if (msg.resultqueue == msg._replyTo) msg._replyTo = null; // don't double message (??)

            }
        } catch (error) {
            NoderedUtil.HandleError(this, error);
        }
        try {
            // if (!NoderedUtil.IsNullEmpty(msg._replyTo) && NoderedUtil.IsNullEmpty(msg.resultqueue)) {
            if (!NoderedUtil.IsNullEmpty(msg._replyTo)) {
                if (msg.payload === null || msg.payload === undefined) { msg.payload == {}; }
                const data: any = {};
                data.state = msg.state;
                if (msg.error) {
                    data.error = "error";
                    if (msg.error.message) {
                        data.error = msg.error.message;
                    }
                }
                data._id = msg._id;
                data.payload = msg.payload;
                data.values = msg.values;
                data.jwt = msg.jwt;
                // ROLLBACK
                // Don't wait for ack(), we don't care if the receiver is there, right ?
                this.node.status({ fill: "blue", shape: "dot", text: "Queue message for " + msg._replyTo });
                await NoderedUtil.QueueMessage(WebSocketClient.instance, msg._replyTo, null, data, msg.correlationId, Config.amqp_workflow_out_expiration);
                // console.log("Send reply data to " + msg._replyTo, data);
            }
        } catch (error) {
            NoderedUtil.HandleError(this, error);
        }
        this.node.send(msg);
        this.node.status({});
    }
    onclose() {
    }
}

export async function get_workflow_forms(req, res) {
    try {
        const rawAssertion = req.user.getAssertionXml();
        const token = await NoderedUtil.GetTokenFromSAML(rawAssertion);
        const result: any[] = await NoderedUtil.Query('forms', { _type: "form" },
            { name: 1 }, { name: -1 }, 1000, 0, token.jwt)
        res.json(result);
    } catch (error) {
        res.status(500).json(error);
    }
}


export async function get_workflows(req, res) {
    try {
        const rawAssertion = req.user.getAssertionXml();
        const token = await NoderedUtil.GetTokenFromSAML(rawAssertion);
        let q: any = { "_type": "workflow" };
        const ors = [];
        if (!NoderedUtil.IsNullEmpty(req.query.name)) {
            ors.push({ name: { $regex: ".*" + req.query.name + ".*" } });
        } else { ors.push({}); }
        if (!NoderedUtil.IsNullEmpty(req.query.id)) {
            ors.push({ _id: req.query.id });
        }
        if (ors.length > 0) {
            q = {
                $and: [
                    q,
                    { $or: ors }
                ]
            };
        }
        const result: any[] = await NoderedUtil.Query('workflow', q, { name: 1 }, { name: -1 }, 100, 0, token.jwt)
        res.json(result);
    } catch (error) {
        res.status(500).json(error);
    }
}





export interface Iassign_workflow_node {
    name: string;
    queue: string;
    targetid: string;
    workflowid: string;
    initialrun: boolean;
}
export class assign_workflow_node {
    public node: Red = null;
    public name: string = "";
    public host: string;
    public localqueue: string = "";
    constructor(public config: Iassign_workflow_node) {
        RED.nodes.createNode(this, config);
        this.node = this;
        this.node.status({});
        Logger.instanse.info("track::assign workflow in::constructor");
        if (this.config == null || this.config.queue == null || this.config.queue == "") {
            this.node.status({ fill: "red", shape: "dot", text: "Missing queue name" });
            return;
        }
        this.host = Config.amqp_url;
        this.node.on("input", this.oninput);
        this.node.on("close", this.onclose);
        WebSocketClient.instance.events.on("onsignedin", this.onsocketsignedin);
        WebSocketClient.instance.events.on("onclose", this.onsocketclose);
        if (WebSocketClient.instance.isConnected && WebSocketClient.instance.user != null) {
            this.connect();
        }
    }
    onsocketsignedin() {
        this.connect();

    }
    onsocketclose(message) {
        if (message == null) message = "";
        if (this.node != null) this.node.status({ fill: "red", shape: "dot", text: "Disconnected " + message });
        this.onclose(false, null);

    }

    async connect() {
        try {
            this.node.status({ fill: "blue", shape: "dot", text: "Connecting..." });
            // if (this.localqueue !== null && this.localqueue !== undefined && this.localqueue !== "") { this.localqueue = Config.queue_prefix + this.localqueue; }

            Logger.instanse.info("track::assign workflow in::connect");
            this.localqueue = this.config.queue;
            this.localqueue = await NoderedUtil.RegisterQueue(WebSocketClient.instance, this.localqueue, (msg: QueueMessage, ack: any) => {
                this.OnMessage(msg, ack);
            });
            this.node.status({ fill: "green", shape: "dot", text: "Connected " + this.localqueue });



            if (!NoderedUtil.IsNullUndefinded(this.config.targetid) && !NoderedUtil.IsNullUndefinded(this.config.workflowid)) {
                const res = await NoderedUtil.Query("users", { "_type": "role", "workflowid": this.config.workflowid }, null, null, 1, 0, null);
                if (res.length == 1) {
                    const role: Role = res[0];
                    const exists = role.members.filter(x => x._id == this.config.targetid);
                    if (exists.length == 0) {
                        role.members.push(new Rolemember("target", this.config.targetid));
                        await NoderedUtil.UpdateOne("users", null, role, 1, true, null);
                    }
                }
            }
        } catch (error) {
            NoderedUtil.HandleError(this, error);
        }
    }
    async OnMessage(msg: any, ack: any) {
        try {
            let result: any = {};
            const data: any = msg.data;
            if (data.state == "idle") return;
            if (!NoderedUtil.IsNullUndefinded(data.__user)) {
                data.user = data.__user;
                delete data.__user;
            }
            if (!NoderedUtil.IsNullUndefinded(data.__jwt)) {
                data.jwt = data.__jwt;
                delete data.__jwt;
            }
            // delete data.jwt;
            let _id = data._id;
            if (_id === null || _id === undefined || _id === "") {
                if (data.payload !== null && data.payload !== undefined) {
                    if (data.payload._id !== null && data.payload._id !== undefined && data.payload._id !== "") {
                        _id = data.payload._id;
                    }
                }
            }
            if (_id !== null && _id !== undefined && _id !== "") {
                const res = await NoderedUtil.Query("workflow_instances", { "_id": _id }, { parentid: 1 }, null, 1, 0, data.jwt);
                if (res.length == 0) {
                    NoderedUtil.HandleError(this, "Unknown workflow_instances id " + _id);
                    if (ack !== null && ack !== undefined) ack();
                    return;
                }
                const currentinstance = res[0];
                const state = res[0].state;
                const _parentid = res[0].parentid;
                if (_parentid !== null && _parentid !== undefined && _parentid !== "") {
                    const res2 = await NoderedUtil.Query("workflow_instances", { "_id": _parentid }, null, null, 1, 0, null);
                    if (res2.length == 0) {
                        NoderedUtil.HandleError(this, "Unknown workflow_instances parentid " + _parentid);
                        if (ack !== null && ack !== undefined) ack();
                        return;
                    }
                    const parentinstance = res2[0];
                    result = parentinstance.msg;
                    if (NoderedUtil.IsNullUndefinded(result)) result = {};
                    result.state = data.state;
                    result.payload = data.payload;
                    result.jwt = data.jwt;
                    result.user = data.user;
                    this.node.send([null, result]);
                    if (ack !== null && ack !== undefined) ack();
                    // await NoderedUtil.UpdateOne("workflow_instances", null, res[0], 1, false, null);
                    return;
                }
            }
            result.payload = data.payload;
            result.jwt = data.jwt;
            result.user = data.user;
            this.node.send([null, result]);
            if (ack !== null && ack !== undefined) ack();
        } catch (error) {
            NoderedUtil.HandleError(this, error);
        }
    }
    async oninput(msg: any) {
        try {
            this.node.status({ fill: "blue", shape: "dot", text: "Processing" });
            // if (this.localqueue !== null && this.localqueue !== undefined && this.localqueue !== "") { this.localqueue = Config.queue_prefix + this.localqueue; }
            const workflowid = (!NoderedUtil.IsNullEmpty(this.config.workflowid) ? this.config.workflowid : msg.workflowid);
            let name = this.config.name;
            if (NoderedUtil.IsNullEmpty(name)) name = msg.name;
            if (NoderedUtil.IsNullEmpty(name)) name = this.config.queue;
            const targetid = (!NoderedUtil.IsNullEmpty(this.config.targetid) ? this.config.targetid : msg.targetid);

            if (NoderedUtil.IsNullEmpty(targetid)) {
                this.node.status({ fill: "red", shape: "dot", text: "targetid is mandatory" });
                return;
            }
            if (NoderedUtil.IsNullEmpty(workflowid)) {
                this.node.status({ fill: "red", shape: "dot", text: "workflowid is mandatory" });
                return;
            }
            let jwt = msg.jwt;
            const initialrun = (!NoderedUtil.IsNullEmpty(msg.initialrun) ? msg.initialrun : this.config.initialrun);
            if (NoderedUtil.IsNullEmpty(jwt) && !NoderedUtil.IsNullUndefinded(WebSocketClient.instance)
                && !NoderedUtil.IsNullEmpty(WebSocketClient.instance.jwt)) {
                jwt = WebSocketClient.instance.jwt;
            }


            msg.jwt = (await NoderedUtil.RenewToken(jwt, true)).jwt;
            // Logger.instanse.info("run workflow called with id " + msg._id + " (" + msg.name + ")");
            const runnerinstance = new Base();
            runnerinstance._type = "instance";
            runnerinstance.name = "runner: " + name;
            (runnerinstance as any).queue = this.localqueue;
            (runnerinstance as any).state = "idle";
            (runnerinstance as any).msg = msg;
            (runnerinstance as any).jwt = msg.jwt;
            const who = WebSocketClient.instance.user;
            Base.addRight(runnerinstance, who._id, who.name, [-1]);

            const res3 = await NoderedUtil.InsertOne("workflow_instances", runnerinstance, 1, true, jwt);
            // Logger.instanse.info("created runner instance with id " + res3._id + " (" + res3.name + ")");
            msg._parentid = res3._id;

            msg.newinstanceid = await NoderedUtil.CreateWorkflowInstance(targetid, workflowid, null, this.localqueue, res3._id, msg.payload, initialrun, jwt);;

            this.node.send(msg);
            this.node.status({ fill: "green", shape: "dot", text: "Connected " + this.localqueue });
        } catch (error) {
            NoderedUtil.HandleError(this, error);
        }
    }
    async onclose(removed: boolean, done: any) {
        if (!NoderedUtil.IsNullEmpty(this.localqueue) && removed) {
            NoderedUtil.CloseQueue(WebSocketClient.instance, this.localqueue);
            this.localqueue = "";
        }
        WebSocketClient.instance.events.removeListener("onsignedin", this.onsocketsignedin);
        WebSocketClient.instance.events.removeListener("onclose", this.onsocketclose);
        if (done != null) done();
    }
}