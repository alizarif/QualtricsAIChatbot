Qualtrics.SurveyEngine.addOnload(function() {
    var that = this;

    // OpenAI API configuration
    var apiKey = "Open_AI_API_KEY";
    var assistantId = "assistant_id"; 
    var threadId = null;

    // Create chat interface
    var chatContainer = document.createElement("div");
    chatContainer.id = "chat-container";
    chatContainer.style.height = "400px";
    chatContainer.style.overflowY = "scroll";
    chatContainer.style.border = "1px solid #ddd";
    chatContainer.style.borderRadius = "8px";
    chatContainer.style.padding = "15px";
    chatContainer.style.marginBottom = "15px";
    chatContainer.style.backgroundColor = "#f9f9f9";

    var inputBox = document.createElement("input");
    inputBox.type = "text";
    inputBox.id = "user-input";
    inputBox.style.width = "70%";
    inputBox.style.padding = "8px";
    inputBox.style.marginRight = "10px";
    inputBox.style.borderRadius = "4px";
    inputBox.style.border = "1px solid #ccc";

    var sendButton = document.createElement("button");
    sendButton.textContent = "Send";
    sendButton.onclick = sendMessage;
    sendButton.style.padding = "8px 15px";
    sendButton.style.backgroundColor = "#4CAF50";
    sendButton.style.color = "white";
    sendButton.style.border = "none";
    sendButton.style.borderRadius = "4px";
    sendButton.style.cursor = "pointer";

    // Append elements to the question container
    var container = this.getQuestionContainer();
    container.appendChild(chatContainer);
    container.appendChild(inputBox);
    container.appendChild(sendButton);

    // Function to send message and get response
    function sendMessage() {
        var userInput = inputBox.value;
        if (!userInput) return;

        displayMessage("User: " + userInput, "user-message");
        inputBox.value = "";

        // Call OpenAI API to create a new thread or add to existing thread
        fetch("https://api.openai.com/v1/threads" + (threadId ? "/" + threadId + "/messages" : ""), {
            method: threadId ? "POST" : "POST",
            headers: {
                "Authorization": "Bearer " + apiKey,
                "Content-Type": "application/json",
                "OpenAI-Beta": "assistants=v1"
            },
            body: JSON.stringify(threadId ? {
                role: "user",
                content: userInput
            } : {
                messages: [{ role: "user", content: userInput }]
            })
        })
        .then(response => response.json())
        .then(data => {
            threadId = threadId || data.id; // Update the thread ID for continuity in conversation
            return fetch("https://api.openai.com/v1/threads/" + threadId + "/runs", {
                method: "POST",
                headers: {
                    "Authorization": "Bearer " + apiKey,
                    "Content-Type": "application/json",
                    "OpenAI-Beta": "assistants=v1"
                },
                body: JSON.stringify({
                    assistant_id: assistantId
                })
            });
        })
        .then(response => response.json())
        .then(data => checkRunStatus(data.id))
        .catch(error => console.error('Error:', error));
    }

    function checkRunStatus(runId) {
        fetch("https://api.openai.com/v1/threads/" + threadId + "/runs/" + runId, {
            headers: {
                "Authorization": "Bearer " + apiKey,
                "OpenAI-Beta": "assistants=v1"
            }
        })
        .then(response => response.json())
        .then(data => {
            if (data.status === "completed") {
                getMessages();
            } else if (data.status === "failed") {
                displayMessage("Assistant: Sorry, there was an error processing your request.", "assistant-message");
            } else {
                setTimeout(() => checkRunStatus(runId), 1000); // Poll every second
            }
        })
        .catch(error => console.error('Error:', error));
    }

    function getMessages() {
        fetch("https://api.openai.com/v1/threads/" + threadId + "/messages", {
            headers: {
                "Authorization": "Bearer " + apiKey,
                "OpenAI-Beta": "assistants=v1"
            }
        })
        .then(response => response.json())
        .then(data => {
            var assistantMessage = data.data.find(msg => msg.role === "assistant");
            if (assistantMessage) {
                displayMessage("Assistant: " + assistantMessage.content[0].text.value, "assistant-message");
            }
        })
        .catch(error => console.error('Error:', error));
    }

    function displayMessage(message, className) {
        var messageElement = document.createElement("p");
        messageElement.textContent = message;
        messageElement.className = className;
        messageElement.style.padding = "10px";
        messageElement.style.borderRadius = "8px";
        messageElement.style.marginBottom = "10px";
        
        if (className === "user-message") {
            messageElement.style.backgroundColor = "#e1f5fe";
            messageElement.style.alignSelf = "flex-end";
        } else {
            messageElement.style.backgroundColor = "#f0f4c3";
        }
        
        chatContainer.appendChild(messageElement);
        chatContainer.scrollTop = chatContainer.scrollHeight; // Auto scroll to the latest message
    }

    // Add event listener for Enter key
    inputBox.addEventListener("keypress", function(event) {
        if (event.key === "Enter") {
            event.preventDefault();
            sendMessage();
        }
    });
});
