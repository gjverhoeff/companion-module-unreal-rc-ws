# Unreal Engine Remote Control Bitfocus Companion Module

Module to trigger and receive Unreal Engine Remote Control over Websockets. 

## Setup
As the module is not submitted to Bitfocus yet clone the repository in a folder. Make sure NodeJS is installed and run ``npm install `` in the folder.

When opening Companion click the cogwheel in the right top to set developer modules. Depending what version you run it will look different. Make sure that you take the parent folder as set folder. 

## Usage
The module provides simple actions for functions and property changes that can be done in **active** Remote Control presets. This means that the module is most likely of use when using Motion Design. 

In module settings you can enable automatic reconnect and define the reconnect interval in milliseconds. The default interval is **5000 ms**.

To reduce load and avoid freezes during rapid trigger bursts, feedback checks are currently disabled in this build.

**Current Actions**
- Every function will be added as a separate action including the possibility to change basic parameters (string, bool, float, int, enum, name, text)
- **Send raw WebSocket message** for your own messages
- **Set Boolean** to change an exposed boolean
- **Set Enum** set the enum based on given value. You will have to give the exact string valule of the enum at the moment. 
- **Set Float** to change exposed float
- **Set Integer** to change exposed integer
- **Set Name (FName)** to change exposed FName
- **Set String** to change exposed FString
- **Set Text** to change exposed FText

**Current Feedback**
- Feedback definitions are disabled (no periodic or automatic property-read checks).

### Help
Feel free to submit any pull request or help each other out in the issues section of this GitHub. At the moment the module does everything I need it to do, but will expand upon it when needed for projects. 


### Acknowledgement
ChatGPT was partly used to make this module. 
