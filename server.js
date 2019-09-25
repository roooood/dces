var colyseus = require('colyseus'),
    request = require("Request"),
    autoBind = require('react-autobind'),
    Connection = require('./connection');

class State {
    constructor() {
        this.started = false;
        this.manager = null;
        this.players = {};
        this.rules = {};
        this.online = 0;
        this.message = [];
    }
}
class metaData {
    constructor(options) {
        this.title = options.title;
        this.owner = options.owner;
        this.ownerId = options.id;
        this.min = Number(options.min);
        this.max = Number(options.max);
        this.player = (options.player > 1 && options.player < 9) ? options.player : 2;
        this.ready = 0;
    }
}
class Server extends colyseus.Room {
    constructor(options) {
        super(options);
        this.first = true;
        autoBind(this);
    }
    async onInit(options) {
        this.setState(new State);
        await Connection.query('SELECT * FROM `dice_setting` LIMIT 1')
            .then(results => {
                this.setting = results[0];
                this.setting.timer = parseInt(this.setting.timer) * 1000;
            });
    }
    requestJoin(options, isNewRoom) {
        return (options.create) ?
            (options.create && isNewRoom) :
            this.clients.length > 0;
    }
    async onAuth(options) {
        let ret = {
            guest: true
        };
        if (options.key != 0)
            await Connection.query('SELECT * FROM `users` LEFT JOIN `dice_users` ON `dice_users`.`uid` = `users`.`userId` LEFT JOIN `wallets` ON `users`.`token` = `wallets`.`token` where `users`.`token`=? LIMIT 1', [options.key])
                .then(results => {
                    if (results[0] != null) {
                        ret = {
                            id: results[0].userId,
                            name: results[0].username,
                            balance: results[0].balance || 0
                        };
                        if (results[0].admin == 1) {
                            ret.admin = true;
                        }
                        else if (results[0].mute == 1) {
                            ret.mute = true;
                        }
                    }
                }, e => {
                    ret = {
                        guest: true
                    };
                });
        return ret;
    }
    onJoin(client, options, auth) {
        if (this.first) {
            this.meta = new metaData({
                title: options.title || 'Zoker Dice',
                min: options.min || this.setting.minbet,
                max: options.max || this.setting.maxbet,
                player: options.player || 4,
                owner: auth.name,
                id: auth.id
            });
            this.setMetadata(this.meta);
            this.state.rules = {
                bet: this.meta.min,
                type: 'max',
                set: false
            }
        }
        if ('guest' in auth) {
            client.guest = true;
            client.mute = true;

        } else {
            client.guest = false;
            for (let i in auth)
                client[i] = auth[i];
        }
        this.send(client, {
            welcome: { ...this.meta, roomID: this.roomId },

        });

        let cl;
        for (cl of this.clients) {
            if (!cl.guest && (cl.id == client.id && client.sessionId != cl.sessionId)) {
                client.close();
            }
        }
        if (this.first) {
            this.first = false;
            this.timer = this.clock.setTimeout(() => {
                this.sit(client, 1)
            }, 1000);

        }
        for (let sit in this.state.players) {
            if (this.state.players[sit].id == client.id) {
                client.sit = sit;
                this.clock.setTimeout(() => {
                    this.send(client, { mySit: client.sit });
                }, 500);
                delete this.state.players[sit].leave;

            }
        }
        this.state.online = this.state.online + 1;
    }
    onMessage(client, message) {
        let type = Object.keys(message)[0];
        if (client.guest == true) {
            return;
        }

        let value = message[type];
        switch (type) {
            case 'sit':
                this.sit(client, value)
                break;
            case 'stand':
                this.stand(client)
                break;
            case 'rules':
                if (this.state.manager == client.sit)
                    this.rules(client, value)
                break;
            case 'imReady':
                this.checkStart(client, true)
                break;
            case 'roll':
                this.roll(client, value)
                break;
            case 'chat':
                if (!('mute' in client))
                    this.chat(client, value)
                break;
            case 'mute':
                if ('admin' in client)
                    this.muteUser(value);
                break;
            case 'delete':
                if ('admin' in client)
                    this.deleteChat(value);
                break;
        }
    }
    onLeave(client, consented) {
        this.state.online = this.state.online - 1;
        this.checkState(client)
    }
    onDispose() {

    }

    sit(client, id) {
        if (client.balance < this.state.rules.bet) {
            this.send(client, { balanceLimit: true });
            return;
        }
        if (this.state.players[id] == null) {
            if (client.sit > 0 && this.state.started) {
                return;
            }
            this.stand(client);
            client.sit = id;
            this.state.players[id] = { id: client.id, name: client.name };
            this.setClientReady();
            if (!this.state.started)
                this.canStart();
            this.send(client, { mySit: id });
            return true;
        }

        return false;
    }
    checkState(client) {
        let sit = client.sit || 0;
        if (sit > 0) {
            if (!this.state.started) {
                this.standBySit(sit);
                return;
            }
            if (['rule'].includes(this.in)) {
                if (this.ready() == 2) {
                    this.over();
                }
                this.standBySit(sit);
                if (this.state.manager == sit) {
                    this.clearTimer();
                    this.takeRules()
                }
                return;
            }
            if (['rolling'].includes(this.in)) {
                if (this.state.players[sit].ready == true && ('dice' in this.state.players[sit])) {
                    this.state.players[client.sit].leave = true;
                }
                else {
                    this.standBySit(sit);
                    if (this.ready() < 2) {
                        this.over();
                    }
                    else {
                        this.checkRoll();
                    }
                }
                return;
            }
            if ('ready' in this.state.players[sit]) {
                if (this.state.players[sit].ready == false) {
                    this.standBySit(sit)
                }
                else {
                    this.state.players[client.sit].leave = true;
                }
            }

        }
    }
    stand(client) {
        let sit = client.sit || 0;
        if (sit > 0) {
            this.checkState(client);
        }
    }
    standBySit(sit) {
        delete this.state.players[sit];
        let user = this.userBySit(sit);
        if (user > -1)
            delete this.clients[user].sit;
        this.setClientReady();
    }
    checkSit(client) {
        if (!client)
            return;
        if (client.balance < this.state.rules.bet) {
            this.send(client, { balanceLimit: true });
            // this.stand(client);
            this.state.players[client.sit].ready = false;
            this.state.players[client.sit].dice = null;
        }
    }
    checkSits() {
        let i, user;
        for (i in this.state.players) {
            user = this.userBySit(i);
            if (user > -1)
                this.checkSit(this.clients[user]);
        }
    }
    canStart() {
        this.clearTimer();
        this.timer = this.clock.setTimeout(() => {
            if (this.ready() > 1) {
                this.start();
            }
        }, 1500);
    }
    start() {
        this.state.manager = this.randomRegnant();
        this.state.started = true;
        this.newRound();
    }
    newRound() {
        this.reset();
        this.in = 'rule';
        this.setTimer(this.getRules, 1000);
    }
    getRules() {
        if (this.ready() < 2) {
            this.state.started = false;
            return;
        }
        this.setTimer(this.takeRules, this.setting.timer);
        this.broadcast({ rules: this.state.manager })
    }
    rules(client, obj) {
        if (client.sit == this.state.manager) {
            this.clearTimer();
            let bet = Number(obj.bet);
            this.state.rules.bet = bet > this.meta.min && bet < this.meta.max ? bet : this.meta.min;
            this.state.rules.type = obj.type;
            this.state.rules.set = true;
            this.roundStart();
        }
    }
    takeRules() {
        if (!this.state.rules.set) {
            this.state.rules = {
                bet: this.meta.min,
                type: 'max',
                set: true
            }
            this.roundStart();
        }
    }

    roundStart() {
        this.checkSits();
        this.in = 'rolling';
        this.state.rules.bank = 0;
        let count = 0, i, user;
        for (i in this.state.players) {
            if (!('ready' in this.state.players[i])) {
                user = this.userBySit(i);
                count++;
                this.state.players[i].ready = true;
                if (user > -1)
                    this.send(this.clients[user], { roll: true });
            }
        }
        if (count > 1) {
            this.setTimer(this.autoRoll, this.setting.timer);
        } else {
            this.over();
        }
    }
    roll(client, roll) {
        if (roll) {
            let dices = [this.random(1, 6), this.random(1, 6)];
            this.state.players[client.sit].dice = dices;
            this.state.rules.bank = this.add(this.state.rules.bank, this.state.rules.bet);
            this.broadcast({ company: client.sit });
            this.updateUserBalance(client.id, client.balance, - this.state.rules.bet)
            client.balance = this.add(client.balance, -this.state.rules.bet);
        }
        else {
            this.state.players[client.sit].ready = false;
            this.state.players[client.sit].dice = null;
        }
        this.checkRoll();
    }
    autoRoll() {
        let sit;
        for (sit in this.state.players) {
            if (('leave' in this.state.players[sit])) {
                this.state.players[sit].ready = false;
                this.state.players[sit].dice = null;
            }
            else if (this.state.players[sit].ready == true && !('dice' in this.state.players[sit])) {
                let dices = [this.random(1, 6), this.random(1, 6)];
                this.state.players[sit].dice = dices;
                this.state.rules.bank = this.add(this.state.rules.bank, this.state.rules.bet);
                this.broadcast({ company: sit });
                let id = this.state.players[sit].id;
                let user = this.userById(id);
                let balance = user > -1 ? this.clients[user].balance : 0;
                this.updateUserBalance(id, balance, -this.state.rules.bet);
                if (user > -1)
                    this.clients[user].balance = this.add(this.clients[user].balance, -this.state.rules.bet);
            }
        }
        this.checkRoll();

    }
    checkRoll() {
        let pass = true;
        let count = 0;
        for (let sit in this.state.players) {
            if ('ready' in this.state.players[sit]) {
                if (!('dice' in this.state.players[sit])) {
                    pass = false;
                }
                else if (('dice' in this.state.players[sit]) && this.state.players[sit].dice != null) {
                    count++;
                }
            }
        }
        if (count < 2 && pass) {
            this.over();
            return;
        }
        if (pass) {
            this.clearTimer();
            this.in = 'rolled';
            this.clock.setTimeout(this.preResult, 4000);
        }
    }
    returnBalance() {
        for (let sit in this.state.players) {
            if (this.state.players[sit].ready == true && ('dice' in this.state.players[sit])) {
                let id = this.state.players[sit].id;
                let user = this.userById(id);
                let balance = user > -1 ? this.clients[user].balance : 0;
                this.updateUserBalance(id, balance, this.state.rules.bet);
                if (user > -1)
                    this.clients[user].balance += this.state.rules.bet;
            }
        }
    }
    preResult() {
        if (this.ready() > 1) {
            let date = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
            let point = {
                bet: this.state.rules.bank, commission: this.setting.commission, time: date
            }
            Connection.query('INSERT INTO `dice_points` SET ?', point)
                .then(results => {
                    Connection.query('SELECT LAST_INSERT_ID() AS `last_id` ')
                        .then(result => {
                            let id = result[0]['last_id'];
                            this.result(id);
                        });
                });

        } else {
            this.state.started = false;
            this.reset();
        }
    }
    result(xid) {
        let sit, tmp = [], win = [], lose = [], id, company = {}, sum, user, balance, state;
        for (sit in this.state.players) {
            if (this.state.players[sit].ready == true) {
                sum = this.state.players[sit].dice.reduce((a, b) => a + b);
                tmp.push(sum);
                company[sit] = sum;
            }
        }
        if (tmp.length > 1) {
            let res = this.state.rules.type == 'max' ? Math.max(...tmp) : Math.min(...tmp);
            for (sit in company) {
                if (company[sit] == res) {
                    win.push(parseInt(sit));
                }
                else {
                    lose.push(parseInt(sit));
                }
            }
            let commission = (Number(this.setting.commission) * this.state.rules.bank) / 100;
            let amount = this.add(this.state.rules.bank, -commission);
            console.log('====================================');
            console.log(commission, this.state.rules.bank, amount);
            console.log('====================================');
            amount /= win.length;
            for (sit in company) {
                user = this.userBySit(sit);
                if (company[sit] == res) {
                    state = true;
                    if (user > -1)
                        this.send(this.clients[user], { win: true });
                }
                else {
                    state = false;
                    if (user > -1)
                        this.send(this.clients[user], { lose: true });
                }

                let result = {
                    pid: xid,
                    uid: this.state.players[sit].id,
                    cash: state ? amount : this.state.rules.bet,
                    type: state ? 'win' : 'lose'
                }
                Connection.query('INSERT INTO `dice_result` SET ?', result);
            }

            for (sit of win) {
                user = this.userBySit(sit);
                id = this.state.players[sit].id;
                balance = user > -1 ? this.clients[user].balance : 0;
                this.updateUserBalance(id, balance, amount);
                if (user > -1) {
                    this.clients[user].balance += amount;
                }
            }
            this.broadcast({ result: { win, lose } });

        }
        this.setTimer(this.canStart, 2500);
    }
    sendToPlayer(option) {
        for (let client in this.clients) {
            if ('sit' in this.clients[client]) {
                this.send(this.clients[client], option);
            }
        }
    }
    reset() {
        this.state.rules = {
            bet: this.meta.min,
            set: false
        };
        this.broadcast({ reset: true });
        this.checkLeave();
        let i, user;
        for (i in this.state.players) {
            delete this.state.players[i].dice;
            delete this.state.players[i].ready;
            user = this.userBySit(i);
            this.checkSit(this.clients[user]);
        }
    }
    over() {
        this.returnBalance();
        this.state.started = false;
        this.clearTimer();
        this.reset();
        this.canStart();
    }
    checkLeave() {
        let check = false;
        for (let i in this.state.players) {
            if ('leave' in this.state.players[i]) {
                this.standBySit(i);
                check = true;
            }
        }
        return check;
    }
    setClientReady() {
        this.meta.ready = this.ready();
        this.setMetadata(this.meta);
    }
    ready() {
        return Object.keys(this.state.players).length;
    }

    randomRegnant() {
        let rand = Object.keys(this.state.players);
        let get = this.random(0, rand.length);
        let manager = rand[get];
        if (manager == this.state.manager) {
            return this.randomRegnant();
        }
        else
            return manager;
    }
    random(min, max) {
        return Math.floor(Math.random() * max) + min;
    }
    chat(client, msg) {
        let message = {
            uid: client.id, text: msg, type: 'game'
        }
        Connection.query('INSERT INTO `dice_message` SET ?', message)
            .then(results => {
                Connection.query('SELECT LAST_INSERT_ID() AS `last_id` ')
                    .then(result => {
                        let id = result[0]['last_id'];
                        this.state.message.unshift({
                            id: id,
                            uid: client.id,
                            sender: client.name,
                            message: msg
                        })
                    });
            });
    }
    objectsEqual(o1, o2) {
        return Object.keys(o1).every(key => o1[key] == o2[key]);
    }
    arraysEqual(a1, a2) {
        return a1.length === a2.length && a1.every((o, idx) => this.objectsEqual(o, a2[idx]));
    }
    checkMessage() {
        let len = this.state.message.length;
        Connection.query('SELECT `dice_message`.*,`users`.`username` FROM `dice_message`  LEFT JOIN `users`  ON `dice_message`.`uid`=`users`.`userId` ORDER BY `dice_message`. `id` DESC LIMIT ' + len)
            .then(results => {
                let res, data = [];
                for (res of results) {
                    data.push({
                        id: res.id,
                        uid: res.uid,
                        sender: res.username,
                        message: res.text
                    })
                }
                if (!this.arraysEqual(data, this.state.message)) {
                    this.state.message = data;
                }
            });
    }
    deleteChat(id) {
        Connection.query('DELETE FROM `dice_message` WHERE `id` =  ?', [id]);
        this.checkMessage();
    }
    muteUser(user) {
        Connection.query('SELECT * FROM `dice_users` WHERE `uid` = ?', [user])
            .then(results => {
                if (results[0] == null) {
                    Connection.query('DELETE FROM `dice_message` WHERE `uid` = ?', [user]);
                    for (let i in this.clients) {
                        if (this.clients[i].id == user) {
                            this.clients[i].mute = true;
                        }
                    }
                    let message = {
                        uid: user, mute: 1
                    }
                    Connection.query('INSERT INTO `dice_users` SET ?', message);
                    this.checkMessage();
                }
            });

    }
    setTimer(callBack, timing) {
        this.timer = this.clock.setTimeout(() => callBack(), timing);
    }
    clearTimer() {
        if (this.timer != undefined) {
            this.timer.clear();
        }
    }
    userById(id) {
        let i;
        for (i in this.clients) {
            if (this.clients[i].id == id) {
                return i;
            }
        }
        return -1;
    }
    userBySit(sit) {
        let i;
        for (i in this.clients) {
            if (this.clients[i].sit == sit) {
                return i;
            }
        }
        return -1;
    }
    close() {
        let i;
        for (i in this.clients) {
            this.clients[i].close();
        }
    }
    updateUserBalance(id, balance, amount) {
        let user = this.userById(id);
        if (user > -1)
            this.send(this.clients[user], { balance: [balance, amount] })
        return;
        var user_token = "";
        Connection.query('SELECT * FROM `users` where `users`.`userId`=? LIMIT 1', [id])
            .then(results => {
                {
                    user_token = results[0].token;
                    var pid = 5;
                    var description;
                    var url = 'http://api.trends.bet';
                    var won = 0;
                    var odd = 0;
                    var match_id = 0;

                    if (amount != 0) {
                        if (amount > 0) {
                            description = 'برد کرش';
                        } else {
                            description = 'شروع کرش';
                        }

                        var options = {
                            method: 'POST',
                            url: url + '/api/webservices/wallet/change',
                            headers:
                            {
                                'cache-control': 'no-cache',
                                'x-access-token': user_token,
                                'content-type': 'multipart/form-data'
                            },
                            formData:
                            {
                                pid: pid,
                                user_token: user_token,
                                amount: amount,
                                description: description
                            }
                        };
                        request(options, function (error, response, body) {
                            if (error) throw new Error(error);
                        });

                        Connection.query('SELECT * FROM `dice_result` WHERE `uid` = ? ORDER BY `id` DESC LIMIT 1', [id])
                            .then(result => {
                                if (result[0] != null) {
                                    match_id = result[0].id;
                                    if (amount < 0) {
                                        //store bet

                                        won = -1;
                                        var form_data = {
                                            pid: pid,
                                            user_token: user_token,
                                            amount: amount,
                                            odd: 1,
                                            sport_name: 'dice',
                                            match_id: match_id,
                                            won: won,
                                            choice: '-'
                                        };
                                        var options = {
                                            method: 'POST',
                                            url: url + '/api/webservices/bet/store',
                                            headers: {
                                                'cache-control': 'no-cache',
                                                'x-access-token': user_token,
                                                'content-type': 'multipart/form-data'
                                            },
                                            formData: form_data
                                        };
                                        request(options, function (error, response, body) {
                                            if (error) throw new Error(error);
                                        });
                                    }
                                    else {
                                        //update bet

                                        won = 2;
                                        var form_data =
                                        {
                                            pid: pid,
                                            amount: amount,
                                            user_token: user_token,
                                            odd: 1,
                                            sport_name: 'dice',
                                            match_id: match_id,
                                            won: won,
                                        }
                                        var options = {
                                            method: 'POST',
                                            url: url + '/api/webservices/bet/update',
                                            headers: {
                                                'cache-control': 'no-cache',
                                                'x-access-token': user_token,
                                                'content-type': 'multipart/form-data'
                                            },
                                            formData: form_data
                                        };
                                        request(options, function (error, response, body) {
                                            if (error) throw new Error(error);
                                        });

                                    }
                                }
                            });
                    }

                }
            }, e => {

            });
    }
    add(a, b) {
        let p = 1000000;
        if (a < 1 || b < 1) {
            a = (a + "").substr(0, 8);
            b = (b + "").substr(0, 8);
            a = Number(a) * p;
            b = Number(b) * p;
            return (a + b) / p;
        }
        return (a + b);
    }
}



module.exports = Server;