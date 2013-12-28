var miaou = miaou || {};
(function(){
	var NB_MESSAGES = 500,
		MAX_AGE_FOR_EDIT = 1800, // seconds (should be coherent with server settings) 
		DISRUPTION_THRESHOLD = 60*60, // seconds
		nbUnseenMessages = 0, nbUnseenPings = 0,
		users = [],
		voteLevels = [{key:'pin',icon:'&#xe813;'}, {key:'star',icon:'&#xe808;'}, {key:'up',icon:'&#xe800;'}, {key:'down',icon:'&#xe801;'}],
		timeOffset, lastReceivedPing = 0, enterTime; // both in seconds since epoch, server time
	
	function setEnterTime(serverTime){
		enterTime = serverTime;
		timeOffset = Date.now()/1000 - serverTime;
	}
	
	// returns true if the user's authorization level in room is at least the passed one
	function checkAuth(auth) {
		var levels = ['read', 'write', 'admin', 'own'];
		for (var i=levels.length; i-->0;) {
			if (levels[i]===room.auth) return true;
            if (levels[i]===auth) return false;
		}
        return false;
	}

	function getMessages() {
		return $('#messages .message').map(function(){ return $(this).data('message') }).get();
	}

	function pingRegex(name) {
		return new RegExp('@'+name+'(\\b|$)')
	}

	function scrollToBottom(){
		$('#messages').scrollTop($('#messages')[0].scrollHeight)
	}

	function showMessageFlowDisruptions(){
		var lastMessage;
		$('#messages .message').removeClass('disrupt').each(function(i){
			var $this = $(this), message = $this.data('message');
			if (lastMessage && message.created-lastMessage.created > DISRUPTION_THRESHOLD) $this.addClass('disrupt')
			lastMessage = message;
		});
	}
	
	function votesAbstract(message){
		return voteLevels.map(function(l){
			return message[l.key] ? '<span class=vote>'+message[l.key]+' '+l.icon+'</span>' : '';
		}).join('');
	}
	
	function updateNotableMessages(message){
		var yetPresent = false, notableMessages = $('#notablemessages .message').map(function(){
			var msg = $(this).data('message');
			if (message && msg.id===message.id) yetPresent = true;
			return msg;
		}).get();
		if (!yetPresent && message) notableMessages.push(message);
		$('#notablemessages').empty();
		notableMessages.filter(function(m){ return m.score>4 }).sort(function(a,b){ return b.score-a.score })
		.slice(0,12).forEach(function(m){
			$('<div>').addClass('message').data('message',m).attr('mid',m.id).append(
				$('<div>').addClass('content').html(miaou.mdToHtml(m.content.match(/^[^\n]{1,200}/)[0]))
			).append(
				$('<div>').addClass('nminfo').html(votesAbstract(m) + ' ' + moment(m.created*1000).format("D MMMM, HH:mm") + ' by ' + m.authorname)				
			).appendTo('#notablemessages')
		});
	}
	
	function showHasOlderThan(messageId){
		if ($('#messages .message').eq(0).data('message').id<messageId) return;
		$('<div>').addClass('olderLoader').data('mid', messageId).text("load older messages")
		.insertBefore('#messages .message[mid='+messageId+']');
	}
	
	function showError(error){
		console.log('ERROR', error);
		var $md = $('<div>').addClass('error').append(
			$('<div>').addClass('user error').text("Miaou Server")
		).append(
			$('<div>').addClass('content').text(error)
		).appendTo('#messages');
		scrollToBottom();
	}
	
	function showRequestAccess(ar){
		var h;
		if (!ar.answered) h = "<span class=user>"+ar.user.name+"</span> requests access to the room";
		else if (ar.outcome) h = "<span class=user>"+ar.user.name+"</span> has been given "+ar.outcome+" right";
		else h = "<span class=user>"+ar.user.name+"</span> has been denied entry by <span class=user>"+ar.answerer.name+"</span>";
		var $md = $('<div>').html(h).addClass('notification').appendTo('#messages');
		if (checkAuth('admin')) {
			$('<button>').text('Manage Users').click(function(){ $('#auths').click() }).appendTo($md);
			if (!vis()) {
				document.title = (nbUnseenPings?'*':'') + ++nbUnseenMessages + ' - ' + room.name;				
			}
		}
		scrollToBottom();
	}

	function addMessage(message){
		var messages = getMessages(), insertionIndex = messages.length; // -1 : insert at end, i>=0 : insert before i
		if (messages.length===0 || message.id>messages[messages.length-1].id) {
			insertionIndex = -1;
		} else if (messages[0].id>message.id) {
			insertionIndex = 0;
		} else {
			while (messages[--insertionIndex].id>message.id);
		}
		var $content = $('<div>').addClass('content').append(miaou.mdToHtml(message.content, true));
		var $md = $('<div>').addClass('message').append(
			$('<div>').addClass('user').text(message.authorname)
		).append($content).data('message', message).attr('mid', message.id);
		if (message.authorname===me.name) $md.addClass('me');
		$content.find('img').load(scrollToBottom);
		if (message.changed) $md.addClass('edited');
		var votesHtml = votesAbstract(message);
		if (votesHtml.length) $md.append($('<div/>').addClass('messagevotes').html(votesHtml));
		if (~insertionIndex) {
			if (messages[insertionIndex].id===message.id) {
				if (message.vote==='?') message.vote = messages[insertionIndex].vote; 
				$('#messages .message').eq(insertionIndex).replaceWith($md);				
			} else {
				messages.splice(insertionIndex, 0, message);
				$('#messages .message').eq(insertionIndex).before($md);				
			}
		} else {
			messages.push(message);
			$md.appendTo('#messages');
			addToUserList({id: message.author, name: message.authorname});
		}
		if (message.vote==='?') message.vote=null;
		if ($content.height()>150) {
			$content.addClass("closed");
			$md.append('<div class=opener>');
		}
		showMessageFlowDisruptions();
		if (insertionIndex<0) scrollToBottom();
	}
	
	function updateUserList(user, keep){
		for (var i=0; i<users.length; i++) {
			if (users[i].name===user.name) {
				users.splice(i,1);
				break;
			}
		}
		if (keep) users.push(user);
		$('#users').html(users.map(function(u){ return '<span class=user>'+u.name+'</span>' }).reverse().join(''));
	}
	function addToUserList(user){
		updateUserList(user, true);
	}
	
	$(function(){
		var socket = io.connect(location.origin);

		function clearPings() {
			// clear the pings of the current room and ask for the ones of the other rooms
			socket.emit('clear_pings', lastReceivedPing, function(pings){
				if (pings.length) {
					pings.forEach(function(p){ lastReceivedPing = Math.max(lastReceivedPing, p.last) });
					var h = "You've been pinged in room", links = pings.map(function(p){ return '<a target=room_'+p.room+' href='+p.room+'>'+p.roomname+'</a>' });
					if (pings.length==1) h += ' '+links[0];
					else h += 's '+links.slice(0,-1).join(', ')+' and '+links.pop();
					$('<div>').html(h).addClass('notification').appendTo('#messages');
					scrollToBottom();
				}
			});
		}

		vis(function(){
			if (vis()) {
				clearPings();
				nbUnseenMessages = 0; nbUnseenPings = 0;
				document.title = room ? room.name : 'no room';
			}
		});
		
		function gotoMessage(mid){
			var $message = $('#messages .message').filter(function(){ return $(this).data('message').id==mid }).addClass('goingto');
			var mtop = $message.offset().top;
			if (mtop<0) $('#messages').animate({scrollTop: mtop+$('#messages').scrollTop()}, 400);
			setTimeout(function(){ $message.removeClass('goingto'); }, 1000);			
		}

		setInterval(function(){
			if (vis()) clearPings();
		}, 3*60*1000);
		
		socket.on('connect', function(){
			socket.emit('enter', room.id, setEnterTime);
		}).on('get_room', function(unhandledMessage){
			console.log('Server asks room');
			socket.emit('enter', room.id, setEnterTime);
			socket.emit('message', unhandledMessage);
		}).on('message', function(message){
			//~ console.log('received:', message);
			addMessage(message);
			updateNotableMessages(message);
			if (message.created>enterTime) {
				var visible = vis(), ping = pingRegex(me.name).test(message.content);
				if (ping) {
					if (visible) {
						clearPings();
					} else {
						miaou.notify(room, message.authorname, message.content);
						nbUnseenPings++;
					}
				}
				if (!visible) document.title = (nbUnseenPings?'*':'') + ++nbUnseenMessages + ' - ' + room.name;
			}
		}).on('room', function(r){
			if (room.id!==r.id) {
				console.log('SHOULD NOT HAPPEN!');
			}
			room = r;
			localStorage['successfulLoginLastTime'] = "yes";
			localStorage['room'] = room.id;
			document.title = room.name;
			$('#roomname').text(room.name);
			$('#roomdescription').html(miaou.mdToHtml(room.description));
		}).on('notable_message', updateNotableMessages).on('has_older', showHasOlderThan).on('request', function(ar){
			showRequestAccess(ar);
		}).on('reconnect', function(){
			console.log('RECONNECT, sending room again');
			setTimeout(function(){
				socket.emit('enter', room.id, setEnterTime);
			}, 500); // first message after reconnect not always received by server if I don't delay it (todo : elucidate and clean)
		}).on('welcome', scrollToBottom).on('disconnect', function(){
			console.log('DISCONNECT');
		}).on('enter', addToUserList).on('leave', updateUserList).on('error', showError);
		
		$('#messages').on('click', '.message .content img', function(e){
			window.open(this.src);
			e.stopPropagation();
		}).on('click', '.opener', function(e){
			$(this).removeClass('opener').addClass('closer').closest('.message').find('.content').removeClass('closed');
			e.stopPropagation();			
		}).on('click', '.closer', function(e){
			$(this).removeClass('closer').addClass('opener').closest('.message').find('.content').addClass('closed');
			e.stopPropagation();			
		}).on('mouseenter', '.message', function(){
			var $message = $(this), message = $message.data('message'), infos = [];
			if (message.author===me.id) infos.push(Date.now()/1000 - message.created < MAX_AGE_FOR_EDIT ? 'click to edit' : 'too old for edition');
			else infos.push('click to reply');
			infos.push(moment((message.created+timeOffset)*1000).fromNow());
			if (message.changed) infos.push('edited ' + moment(message.changed*1000).fromNow());
			$('<div>').addClass('messagemenu').html(
				infos.map(function(txt){ return '<span class=txt>'+txt+'</span>' }).join(' - ') + ' ' +
				voteLevels.slice(0, message.author===me.id ? 1 : 4).slice(checkAuth('admin')?0:1).map(function(l){
					return '<span class="vote'+(l.key===message.vote?' on':'')+'" vote-level='+l.key+'>'+l.icon+'</span>'
				}).join('')
			).appendTo(this);
		}).on('mouseleave', '.message', function(){
			$('.messagemenu').remove();
		}).on('click', '.message', function(){
			var $message = $(this), message = $message.data('message');
			if (message.authorname===me.name) {
				if (Date.now()/1000 - message.created < MAX_AGE_FOR_EDIT) $('#input').editMessage(message);
			} else {
				$('#input').replyToMessage(message);
			}
		}).on('mouseenter', '.reply', function(e){
			var mid = $(this).attr('to');
			$('#messages .message').filter(function(){ return $(this).data('message').id==mid }).addClass('target');
			e.stopPropagation();
		}).on('mouseleave', '.reply', function(){
			$('.target').removeClass('target');
		}).on('click', '.reply', function(e){
			gotoMessage($(this).attr('to'));
			e.stopPropagation();			
		}).on('click', 'a', function(e){
			e.stopPropagation();
		}).on('click', '.vote', function(e){
			var $e = $(this), message = $e.closest('.message').data('message'), vote = $e.attr('vote-level');
			if (message.vote) socket.emit('vote', {action:'remove',  message:message.id, level:message.vote});
			if (message.vote!=vote) socket.emit('vote', {action:'add',  message:message.id, level:vote});
			return false;
		}).on('click', '.olderLoader', function(e){
			var $this = $(this), mid = +$this.data('mid');
			$this.remove();
			socket.emit('get_older', mid);
		});
		
		$('#notablemessages').on('click', '.message', function(e){
			gotoMessage($(this).attr('mid'));
			e.stopPropagation();			
		});

		$('#input').editFor(socket);
		if (checkAuth('admin')) $('#editroom').click(function(){ location = 'room?id='+room.id });
		else $('#editroom').hide();
		$('#auths').click(function(){ location = 'auths?id='+room.id });			
				
		$('#showPreview').click(function(){
			$(this).hide();
			$('#input').focus();
			$('#previewpanel').css('display','table-row');
			scrollToBottom();
		});
		$('#hidePreview').click(function(){
			$('#input').focus();
			$('#showPreview').show();
			$('#previewpanel').hide();
		});
		$('#input').on('change keyup', function(){
			$('#preview').html(miaou.mdToHtml(this.value));
		});

		console.log('Miaou!');
	});
})();
